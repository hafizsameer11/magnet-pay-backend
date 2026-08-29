/** Logistics full lifecycle smoke. Run: npx tsx scripts/logistics-smoke.ts */
const BASE = process.env.API_URL ?? "http://127.0.0.1:4000";
const BUYER = "+2348123456789";
const ADMIN_PHONE = "+2348000000001";
const PASS = "123456";

type R = { step: string; ok: boolean; detail?: string };
const results: R[] = [];
const ok = (step: string, detail?: string) => {
  results.push({ step, ok: true, detail });
  console.log(`✓ ${step}${detail ? ` — ${detail}` : ""}`);
};
const bad = (step: string, detail: string) => {
  results.push({ step, ok: false, detail });
  console.error(`✗ ${step} — ${detail}`);
};

async function api<T>(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json()) as { data?: T; error?: { code: string; message: string } };
  if (!res.ok) throw new Error(`${res.status} ${json.error?.code}: ${json.error?.message}`);
  return json.data as T;
}

async function adminLogin() {
  const login = await api<{ accessToken: string }>("/auth/login", {
    method: "POST",
    body: { phone: ADMIN_PHONE, passcode: PASS },
  });
  return login.accessToken;
}

async function advanceAdmin(token: string, shipmentId: string, status?: string) {
  return api<{ status: string }>(`/admin/shipments/${shipmentId}/advance`, {
    method: "POST",
    token,
    body: status ? { status, skipSellerShipCheck: true } : { skipSellerShipCheck: true },
  });
}

async function settleAdmin(token: string, shipmentId: string, finalMinor: string) {
  return api<{ shipment: { status: string } }>(`/admin/shipments/${shipmentId}/settle`, {
    method: "POST",
    token,
    body: { finalMinor },
  });
}

async function main() {
  console.log(`\nLogistics smoke → ${BASE}\n`);
  const login = await api<{ accessToken: string }>("/auth/login", {
    method: "POST",
    body: { phone: BUYER, passcode: PASS },
  });
  const token = login.accessToken;
  ok("Buyer login");

  let adminToken = "";
  try {
    adminToken = await adminLogin();
    ok("Admin login");
  } catch (e) {
    bad("Admin login", e instanceof Error ? e.message : String(e));
    return done();
  }

  const parcelTypes = await api<{ id: string; code: string }[]>("/logistics/parcel-types", { token });
  const parcelTypeId = parcelTypes[0]?.id;
  if (!parcelTypeId) {
    bad("Parcel types", "No active parcel types — run migration");
    return done();
  }
  ok("Parcel types", parcelTypes.map((p) => p.code).join(", "));

  const dryRun = await api<{ estimatedMinor: string; formula: string }>("/logistics/estimate", {
    method: "POST",
    token,
    body: { parcelTypeId, weightKg: 120 },
  });
  ok("Dry-run estimate", `${dryRun.estimatedMinor} · ${dryRun.formula}`);

  let quoteId = "";
  let shipmentId = "";
  let lockedMinor = "0";

  try {
    const q = await api<{
      request: { id: string };
      quotes: { id: string; estimatedMinor: string; name?: string }[];
      quote: { id: string; estimatedMinor: string };
    }>("/logistics/quotes", {
      method: "POST",
      token,
      body: {
        cargoDesc: "Logistics smoke cargo",
        cbm: 1.5,
        weightKg: 120,
        origin: "Guangzhou",
        destination: "Lagos",
        mode: "SEA",
        parcelTypeId,
      },
    });
    if (q.quotes.length < 2) bad("Partner compare", `expected ≥2 quotes, got ${q.quotes.length}`);
    else ok("Partner compare", `${q.quotes.length} carriers · ${q.quotes.map((x) => x.name ?? "?").join(", ")}`);

    const listed = await api<{ quotes: { id: string }[] }>(`/logistics/quote-requests/${q.request.id}/quotes`, { token });
    if (listed.quotes.length !== q.quotes.length) bad("List quote request", "count mismatch");
    else ok("List quote request", `${listed.quotes.length} quotes`);

    quoteId = q.quote.id;
    lockedMinor = q.quote.estimatedMinor;
    ok("Request quote", `${quoteId.slice(0, 8)} · ${lockedMinor} NGN (cheapest)`);

    const ship = await api<{ id: string; ref: string; status: string }>(`/logistics/quotes/${quoteId}/book`, {
      method: "POST",
      token,
      body: {},
    });
    shipmentId = ship.id;
    ok("Book shipment", `${ship.ref} · ${ship.status}`);
  } catch (e) {
    bad("Quote/book", e instanceof Error ? e.message : String(e));
    return done();
  }

  try {
    await advanceAdmin(adminToken, shipmentId);
    ok("Admin advance → IN_TRANSIT");
    await advanceAdmin(adminToken, shipmentId, "CUSTOMS");
    ok("Admin advance → CUSTOMS");
    await advanceAdmin(adminToken, shipmentId, "SETTLEMENT_PENDING");
    ok("Admin advance → SETTLEMENT_PENDING");
  } catch (e) {
    bad("Admin advance", e instanceof Error ? e.message : String(e));
  }

  try {
    const finalMinor = String(Math.round(Number(lockedMinor) * 0.85));
    const settled = await settleAdmin(adminToken, shipmentId, finalMinor);
    ok("Admin settle (surplus → cashback)", settled.shipment?.status ?? "ok");
  } catch (e) {
    bad("Admin settle surplus", e instanceof Error ? e.message : String(e));
  }

  try {
    const q2 = await api<{ quote: { id: string; estimatedMinor: string } }>("/logistics/quotes", {
      method: "POST",
      token,
      body: {
        cargoDesc: "Topup smoke",
        cbm: 0.8,
        weightKg: 60,
        origin: "Shenzhen",
        destination: "Lagos",
        mode: "SEA",
        parcelTypeId,
      },
    });
    const s2 = await api<{ id: string }>(`/logistics/quotes/${q2.quote.id}/book`, { method: "POST", token, body: {} });
    await advanceAdmin(adminToken, s2.id);
    await advanceAdmin(adminToken, s2.id, "CUSTOMS");
    await advanceAdmin(adminToken, s2.id, "SETTLEMENT_PENDING");
    const over = String(Math.round(Number(q2.quote.estimatedMinor) * 1.2));
    const settled = await settleAdmin(adminToken, s2.id, over);
    ok("Admin settle (deficit → top-up)", settled.shipment?.status);
    const topped = await api<{ status: string }>(`/logistics/shipments/${s2.id}/top-up`, { method: "POST", token });
    ok("Buyer pay top-up", topped.status);

    const buyerSettle = await fetch(`${BASE}/logistics/shipments/${s2.id}/settle`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ finalMinor: over }),
    });
    if (buyerSettle.status === 403) ok("Buyer settle blocked (admin-only)");
    else bad("Buyer settle blocked", `expected 403 got ${buyerSettle.status}`);
  } catch (e) {
    bad("Deficit / top-up path", e instanceof Error ? e.message : String(e));
  }

  return done();
}

function done() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n── Logistics: ${passed}/${results.length} passed ──`);
  if (failed.length) {
    for (const f of failed) console.log(`  • ${f.step}: ${f.detail}`);
    process.exit(1);
  }
  console.log("All logistics features OK.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
