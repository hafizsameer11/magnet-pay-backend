/** Logistics full lifecycle smoke. Run: npx tsx scripts/logistics-smoke.ts */
const BASE = process.env.API_URL ?? "http://127.0.0.1:4000";
const BUYER = "+2348123456789";
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

async function main() {
  console.log(`\nLogistics smoke → ${BASE}\n`);
  const login = await api<{ accessToken: string }>("/auth/login", {
    method: "POST",
    body: { phone: BUYER, passcode: PASS },
  });
  const token = login.accessToken;
  ok("Login");

  let quoteId = "";
  let shipmentId = "";
  let lockedMinor = "0";

  try {
    const q = await api<{ quote: { id: string; estimatedMinor: string } }>("/logistics/quotes", {
      method: "POST",
      token,
      body: {
        cargoDesc: "Logistics smoke cargo",
        cbm: 1.5,
        weightKg: 120,
        origin: "Guangzhou",
        destination: "Lagos",
        mode: "SEA",
      },
    });
    quoteId = q.quote.id;
    lockedMinor = q.quote.estimatedMinor;
    ok("Request quote", `${quoteId.slice(0, 8)} · ${lockedMinor} NGN`);

    const detail = await api<{ id: string; eta?: string }>(`/logistics/quotes/${quoteId}`, { token });
    ok("Fetch quote", detail.eta ?? "ok");

    const up = await api<{ url: string; name: string }>("/uploads", {
      method: "POST",
      token,
      body: {
        filename: "ci.pdf",
        contentBase64: Buffer.from("logistics smoke invoice").toString("base64"),
        mimeType: "application/pdf",
      },
    });
    ok("Upload booking doc", up.url);

    const ship = await api<{ id: string; ref: string; status: string }>(`/logistics/quotes/${quoteId}/book`, {
      method: "POST",
      token,
      body: { documents: [{ kind: "ci", name: up.name, url: up.url }] },
    });
    shipmentId = ship.id;
    ok("Book shipment", `${ship.ref} · ${ship.status}`);
  } catch (e) {
    bad("Quote/book", e instanceof Error ? e.message : String(e));
    return done();
  }

  try {
    const list = await api<{ id: string }[]>("/logistics/shipments", { token });
    if (!list.some((s) => s.id === shipmentId)) throw new Error("shipment missing from list");
    ok("List shipments", `${list.length} total`);

    const one = await api<{ status: string; documents?: unknown[] }>(`/logistics/shipments/${shipmentId}`, {
      token,
    });
    ok("Get shipment", one.status);
  } catch (e) {
    bad("List/get", e instanceof Error ? e.message : String(e));
  }

  try {
    const a1 = await api<{ status: string }>(`/logistics/shipments/${shipmentId}/advance`, {
      method: "POST",
      token,
      body: {},
    });
    ok("Advance (auto)", a1.status);

    const a2 = await api<{ status: string }>(`/logistics/shipments/${shipmentId}/advance`, {
      method: "POST",
      token,
      body: { status: "CUSTOMS", message: "Cleared export" },
    });
    ok("Advance customs", a2.status);
  } catch (e) {
    bad("Advance", e instanceof Error ? e.message : String(e));
  }

  try {
    const up2 = await api<{ url: string; name: string }>("/uploads", {
      method: "POST",
      token,
      body: {
        filename: "bl.pdf",
        contentBase64: Buffer.from("bill of lading").toString("base64"),
        mimeType: "application/pdf",
      },
    });
    await api(`/logistics/shipments/${shipmentId}/documents`, {
      method: "POST",
      token,
      body: { kind: "bl", name: up2.name, url: up2.url },
    });
    ok("Upload shipment document");
  } catch (e) {
    bad("Shipment docs", e instanceof Error ? e.message : String(e));
  }

  try {
    const finalMinor = String(Math.round(Number(lockedMinor) * 0.85));
    const settled = await api<{ shipment: { status: string } }>(`/logistics/shipments/${shipmentId}/settle`, {
      method: "POST",
      token,
      body: { finalMinor },
    });
    ok("Settle (under hold → cashback)", settled.shipment?.status ?? "ok");
  } catch (e) {
    bad("Settle under", e instanceof Error ? e.message : String(e));
  }

  // New shipment for top-up path
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
      },
    });
    const s2 = await api<{ id: string }>(`/logistics/quotes/${q2.quote.id}/book`, {
      method: "POST",
      token,
      body: {},
    });
    const over = String(Math.round(Number(q2.quote.estimatedMinor) * 1.2));
    const settled = await api<{ shipment: { status: string } }>(`/logistics/shipments/${s2.id}/settle`, {
      method: "POST",
      token,
      body: { finalMinor: over },
    });
    ok("Settle (over hold → top-up required)", settled.shipment?.status);
    const topped = await api<{ status: string }>(`/logistics/shipments/${s2.id}/top-up`, {
      method: "POST",
      token,
    });
    ok("Pay top-up", topped.status);

    const pod = await api<{ status: string }>(`/logistics/shipments/${s2.id}/advance`, {
      method: "POST",
      token,
      body: { status: "DELIVERED", message: "POD confirmed" },
    });
    ok("Confirm POD / delivered", pod.status);
  } catch (e) {
    bad("Top-up / POD path", e instanceof Error ? e.message : String(e));
  }

  try {
    await api(`/logistics/shipments/${shipmentId}/claim`, {
      method: "POST",
      token,
      body: {
        type: "damage",
        description: "Carton corner crushed during transit smoke test",
        amountMinor: "50000",
        evidenceUrls: ["/files/smoke-evidence.jpg"],
      },
    });
    ok("File claim");
  } catch (e) {
    bad("Claim", e instanceof Error ? e.message : String(e));
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
