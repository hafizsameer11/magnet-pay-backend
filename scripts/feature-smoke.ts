/**
 * Feature smoke: recipients, escrow invite, admin invite, send.
 * Run: npx tsx scripts/feature-smoke.ts
 */
const BASE = process.env.API_URL ?? "http://127.0.0.1:4000";
const BUYER = "+2348123456789";
const SELLER = "+8613800138000";
const ADMIN = "+2348000000001";
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

async function api<T>(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
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

async function login(phone: string) {
  const s = await api<{ accessToken: string; user: { id: string } }>("/auth/login", {
    method: "POST",
    body: { phone, passcode: PASS },
  });
  return { token: s.accessToken, id: s.user.id };
}

async function main() {
  console.log(`\nFeature smoke → ${BASE}\n`);
  const buyer = await login(BUYER);
  const seller = await login(SELLER);
  const admin = await login(ADMIN);
  ok("Login buyer/seller/admin");

  // ── Recipients: save / list / delete ──
  let recipientId = "";
  try {
    const created = await api<{ id: string; name: string }>("/recipients", {
      method: "POST",
      token: buyer.token,
      body: {
        name: "Smoke Test Supplier",
        subtitle: "ICBC · Shenzhen",
        rail: "BANK",
        currency: "CNY",
        accountHint: "6228480012345678",
        country: "CN",
      },
    });
    recipientId = created.id;
    ok("Save recipient", created.name);

    const list = await api<{ id: string }[]>("/recipients", { token: buyer.token });
    if (!list.some((r) => r.id === recipientId)) throw new Error("Saved recipient missing from list");
    ok("List recipients", `${list.length} total`);
  } catch (e) {
    bad("Recipients save/list", e instanceof Error ? e.message : String(e));
  }

  // ── Escrow invite (phone) create + seller accept ──
  try {
    const escrow = await api<{ id: string; status: string; inviteToken?: string }>("/escrow", {
      method: "POST",
      token: buyer.token,
      body: {
        title: "Smoke invite deal",
        amountMinor: "100000",
        currency: "CNY",
        invitePhone: SELLER,
        milestones: [{ label: "Full", amountMinor: "100000" }],
      },
    });
    if (!escrow.inviteToken && !escrow.id) throw new Error("No invite token/id");
    // inviteToken may not be on create response — fetch escrow
    const full = await api<{ id: string; inviteToken?: string | null; status: string }>(`/escrow/${escrow.id}`, {
      token: buyer.token,
    });
    const token = full.inviteToken;
    if (!token) throw new Error("Escrow missing inviteToken");
    ok("Create escrow invite", `${escrow.id.slice(0, 8)} · ${full.status}`);

    const preview = await api<{ escrow?: { title: string } }>(`/escrow/invite/${token}`, {
      token: seller.token,
    });
    ok("Seller preview invite", preview.escrow?.title ?? "ok");

    const accepted = await api<{ status: string }>(`/escrow/invite/${token}/accept`, {
      method: "POST",
      token: seller.token,
    });
    ok("Seller accept invite", accepted.status);
  } catch (e) {
    bad("Escrow invite accept", e instanceof Error ? e.message : String(e));
  }

  // ── Escrow invite decline path ──
  try {
    const escrow = await api<{ id: string }>("/escrow", {
      method: "POST",
      token: buyer.token,
      body: {
        title: "Smoke decline deal",
        amountMinor: "50000",
        currency: "CNY",
        invitePhone: SELLER,
      },
    });
    const full = await api<{ inviteToken?: string | null }>(`/escrow/${escrow.id}`, { token: buyer.token });
    const token = full.inviteToken;
    if (!token) throw new Error("No invite token for decline test");
    const declined = await api<{ status?: string }>(`/escrow/invite/${token}/decline`, {
      method: "POST",
      token: seller.token,
    });
    ok("Seller decline invite", String(declined?.status ?? "declined"));
  } catch (e) {
    bad("Escrow invite decline", e instanceof Error ? e.message : String(e));
  }

  // ── Admin user invite ──
  try {
    const phone = `+23480${String(Date.now()).slice(-8)}`;
    const inv = await api<{ invited: boolean; phone?: string }>("/admin/users/invite", {
      method: "POST",
      token: admin.token,
      body: { phone, role: "BUYER" },
    });
    if (!inv.invited) throw new Error(JSON.stringify(inv));
    ok("Admin invite user", phone);
  } catch (e) {
    bad("Admin invite", e instanceof Error ? e.message : String(e));
  }

  // ── Send money to saved recipient ──
  try {
    if (!recipientId) throw new Error("No recipient from earlier step");
    const transfer = await api<{ id: string; status: string }>("/transfers", {
      method: "POST",
      token: buyer.token,
      body: { recipientId, amountMinor: "2500", currency: "CNY", note: "Smoke send" },
    });
    ok("Send to recipient", `${transfer.id.slice(0, 8)} → ${transfer.status}`);
  } catch (e) {
    bad("Send to recipient", e instanceof Error ? e.message : String(e));
  }

  // ── Cleanup recipient ──
  try {
    if (recipientId) {
      await api(`/recipients/${recipientId}`, { method: "DELETE", token: buyer.token });
      ok("Delete recipient");
    }
  } catch (e) {
    bad("Delete recipient", e instanceof Error ? e.message : String(e));
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n── ${passed}/${results.length} passed ──`);
  if (failed.length) {
    for (const f of failed) console.log(`  • ${f.step}: ${f.detail}`);
    process.exit(1);
  }
  console.log("All recipient / invite / send features OK.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
