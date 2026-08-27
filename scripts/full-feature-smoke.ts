/**
 * Full feature smoke — every major app capability against live API.
 * Run: npx tsx scripts/full-feature-smoke.ts
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

async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; allowStatuses?: number[] } = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json()) as { data?: T; error?: { code: string; message: string } };
  if (!res.ok && !(opts.allowStatuses ?? []).includes(res.status)) {
    throw new Error(`${res.status} ${json.error?.code}: ${json.error?.message}`);
  }
  return { status: res.status, data: json.data as T };
}

async function login(phone: string) {
  const { data } = await api<{ accessToken: string; user: { id: string; role: string } }>("/auth/login", {
    method: "POST",
    body: { phone, passcode: PASS },
  });
  return { token: data.accessToken, id: data.user.id, role: data.user.role };
}

async function main() {
  console.log(`\nFull feature smoke → ${BASE}\n`);

  const buyer = await login(BUYER);
  const seller = await login(SELLER);
  const admin = await login(ADMIN);
  ok("Auth · login", "buyer / seller / admin");

  // Auth me
  try {
    await api("/me", { token: buyer.token });
    ok("Me · profile");
  } catch (e) {
    bad("Me · profile", e instanceof Error ? e.message : String(e));
  }

  // Wallets / FX / deposit VA / statement
  try {
    const w = await api<{ wallets: { currency: string; availableMinor: string }[] }>("/wallets", {
      token: buyer.token,
    });
    ok("Wallets · list", `${w.data.wallets?.length ?? 0} currencies`);
    const fx = await api<{ rate: number }>("/wallets/fx/quote", {
      method: "POST",
      token: buyer.token,
      body: { from: "CNY", to: "NGN", amountMinor: "10000" },
    });
    ok("Wallets · FX quote", `rate ${fx.data.rate}`);
    await api("/wallets/virtual-account", { token: buyer.token });
    ok("Wallets · virtual account");
    await api("/wallets/statement?from=2026-01-01&to=2026-12-31", { token: buyer.token });
    ok("Wallets · statement export");
  } catch (e) {
    bad("Wallets", e instanceof Error ? e.message : String(e));
  }

  // Recipients CRUD + send
  let recipientId = "";
  try {
    const created = await api<{ id: string }>("/recipients", {
      method: "POST",
      token: buyer.token,
      body: {
        name: "Full Smoke Recipient",
        rail: "BANK",
        currency: "CNY",
        accountHint: "6228000011112222",
        country: "CN",
      },
    });
    recipientId = created.data.id;
    const list = await api<{ id: string }[]>("/recipients", { token: buyer.token });
    if (!list.data.some((r) => r.id === recipientId)) throw new Error("not listed");
    ok("Recipients · save + list");

    const transfer = await api<{ id: string; status: string }>("/transfers", {
      method: "POST",
      token: buyer.token,
      body: { recipientId, amountMinor: "1500", currency: "CNY", note: "full smoke" },
    });
    ok("Transfers · send", transfer.data.status);

    // create FAILED for retry/refund
    const { prisma } = await import("../src/lib/prisma.js");
    const failed = await prisma.transfer.create({
      data: {
        senderId: buyer.id,
        recipientId,
        currency: "CNY",
        amountMinor: 800n,
        status: "FAILED",
        events: { create: [{ status: "FAILED", message: "smoke fail" }] },
      },
    });
    const retried = await api<{ status: string }>(`/transfers/${failed.id}/retry`, {
      method: "POST",
      token: buyer.token,
    });
    ok("Transfers · retry", retried.data.status);

    const failed2 = await prisma.transfer.create({
      data: {
        senderId: buyer.id,
        recipientId,
        currency: "CNY",
        amountMinor: 600n,
        status: "FAILED",
        events: { create: [{ status: "FAILED", message: "smoke refund" }] },
      },
    });
    const refunded = await api<{ status: string }>(`/transfers/${failed2.id}/refund`, {
      method: "POST",
      token: buyer.token,
    });
    if (refunded.data.status !== "REFUNDED") throw new Error(`expected REFUNDED got ${refunded.data.status}`);
    ok("Transfers · refund", refunded.data.status);
    await prisma.$disconnect();

    await api(`/recipients/${recipientId}`, { method: "DELETE", token: buyer.token });
    ok("Recipients · delete");
  } catch (e) {
    bad("Recipients/Transfers", e instanceof Error ? e.message : String(e));
  }

  // Escrow invite accept + decline + fund + cancel
  try {
    const escrow = await api<{ id: string }>("/escrow", {
      method: "POST",
      token: buyer.token,
      body: {
        title: "Full smoke escrow",
        amountMinor: "80000",
        currency: "CNY",
        invitePhone: SELLER,
        milestones: [
          { label: "Deposit", amountMinor: "40000" },
          { label: "Delivery", amountMinor: "40000" },
        ],
      },
    });
    const full = await api<{ inviteToken?: string | null; status: string }>(`/escrow/${escrow.data.id}`, {
      token: buyer.token,
    });
    const token = full.data.inviteToken;
    if (!token) throw new Error("no invite token");
    await api(`/escrow/invite/${token}`, { token: seller.token });
    await api(`/escrow/invite/${token}/accept`, { method: "POST", token: seller.token });
    ok("Escrow · invite accept");

    const funded = await api<{ status: string }>(`/escrow/${escrow.data.id}/fund`, {
      method: "POST",
      token: buyer.token,
    });
    ok("Escrow · fund", funded.data.status);

    await api("/escrow/meta/fee", { token: buyer.token });
    await api("/escrow/meta/inspectors", { token: buyer.token });
    ok("Escrow · meta fee/inspectors");

    // decline path on fresh invite
    const e2 = await api<{ id: string }>("/escrow", {
      method: "POST",
      token: buyer.token,
      body: { title: "Decline smoke", amountMinor: "20000", currency: "CNY", invitePhone: SELLER },
    });
    const f2 = await api<{ inviteToken?: string | null }>(`/escrow/${e2.data.id}`, { token: buyer.token });
    await api(`/escrow/invite/${f2.data.inviteToken}/decline`, { method: "POST", token: seller.token });
    ok("Escrow · invite decline");

    // cancel an awaiting escrow
    const e3 = await api<{ id: string }>("/escrow", {
      method: "POST",
      token: buyer.token,
      body: {
        title: "Cancel smoke",
        amountMinor: "10000",
        currency: "CNY",
        invitePhone: SELLER,
      },
    });
    await api(` /escrow/${e3.data.id}/cancel`.replace(" ", ""), {
      method: "POST",
      token: buyer.token,
    });
    ok("Escrow · cancel");
  } catch (e) {
    bad("Escrow", e instanceof Error ? e.message : String(e));
  }

  // Market: products, cart, checkout, wishlist, RFQ, seller docs
  let orderId = "";
  let productId = "";
  try {
    const sellerProds = await api<{ id: string; title: string }[]>("/market/seller/products", {
      token: seller.token,
    });
    productId = sellerProds.data[0]?.id;
    if (!productId) throw new Error("seller has no products");

    // clear cart
    const cart = await api<{ items?: { id: string }[] }>("/market/cart", { token: buyer.token });
    for (const item of cart.data.items ?? []) {
      await api(`/market/cart/items/${item.id}`, { method: "DELETE", token: buyer.token });
    }
    await api("/market/cart/items", {
      method: "POST",
      token: buyer.token,
      body: { productId, qty: 1 },
    });
    const order = await api<{ id: string; status: string }>("/market/checkout", {
      method: "POST",
      token: buyer.token,
      body: { addressLabel: "Home", addressLine: "Lagos" },
    });
    orderId = order.data.id;
    ok("Market · cart + checkout", order.data.status);

    await api("/market/wishlist", {
      method: "POST",
      token: buyer.token,
      body: { productId },
    });
    await api(`/market/wishlist/${productId}`, { method: "DELETE", token: buyer.token });
    ok("Market · wishlist add/remove");

    await api("/market/rfq", {
      method: "POST",
      token: buyer.token,
      body: { title: "Smoke RFQ", body: "Need 100 units", qty: "100" },
    });
    ok("Market · RFQ create");

    const upload = await api<{ url: string; name: string }>("/uploads", {
      method: "POST",
      token: seller.token,
      body: {
        filename: "ci.pdf",
        contentBase64: Buffer.from("smoke invoice").toString("base64"),
        mimeType: "application/pdf",
      },
    });
    await api(`/market/seller/orders/${orderId}/documents`, {
      method: "POST",
      token: seller.token,
      body: { kind: "invoice", name: upload.data.name, url: upload.data.url },
    });
    ok("Market · seller order docs");
  } catch (e) {
    bad("Market", e instanceof Error ? e.message : String(e));
  }

  // Logistics
  try {
    const q = await api<{ quote: { id: string } }>("/logistics/quotes", {
      method: "POST",
      token: buyer.token,
      body: {
        cargoDesc: "Smoke cargo",
        cbm: 0.5,
        weightKg: 40,
        origin: "Guangzhou",
        destination: "Lagos",
        mode: "SEA",
      },
    });
    const up = await api<{ url: string; name: string }>("/uploads", {
      method: "POST",
      token: buyer.token,
      body: {
        filename: "pl.pdf",
        contentBase64: Buffer.from("packing").toString("base64"),
        mimeType: "application/pdf",
      },
    });
    const ship = await api<{ id: string; status: string }>(`/logistics/quotes/${q.data.quote.id}/book`, {
      method: "POST",
      token: buyer.token,
      body: { documents: [{ kind: "packing", name: up.data.name, url: up.data.url }] },
    });
    ok("Logistics · quote + book", ship.data.status);
  } catch (e) {
    bad("Logistics", e instanceof Error ? e.message : String(e));
  }

  // Messages / support
  try {
    await api("/messages/conversations", { token: buyer.token });
    await api("/messages/support", {
      method: "POST",
      token: buyer.token,
      body: { topic: "Other", message: "Full smoke support" },
    });
    ok("Messages · conversations + support");
  } catch (e) {
    bad("Messages", e instanceof Error ? e.message : String(e));
  }

  // Me export / addresses / bank / KYC status
  try {
    await api("/me/export", { method: "POST", token: buyer.token });
    await api("/me/kyc/status", { token: buyer.token });
    await api("/me/addresses", { token: buyer.token });
    await api("/me/bank-accounts", { token: buyer.token });
    ok("Me · export / KYC / addresses / bank");
  } catch (e) {
    bad("Me extras", e instanceof Error ? e.message : String(e));
  }

  // Admin invite
  try {
    const phone = `+23480${String(Date.now()).slice(-8)}`;
    const inv = await api<{ invited: boolean }>("/admin/users/invite", {
      method: "POST",
      token: admin.token,
      body: { phone, role: "BUYER" },
    });
    if (!inv.data.invited) throw new Error("not invited");
    await api("/admin/users", { token: admin.token });
    ok("Admin · invite + list users");
  } catch (e) {
    bad("Admin", e instanceof Error ? e.message : String(e));
  }

  // Notifications
  try {
    await api("/notifications", { token: buyer.token });
    ok("Notifications · list");
  } catch (e) {
    bad("Notifications", e instanceof Error ? e.message : String(e));
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n── Summary: ${passed}/${results.length} passed ──`);
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  • ${f.step}: ${f.detail}`);
    process.exit(1);
  }
  console.log("\nAll features OK.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
