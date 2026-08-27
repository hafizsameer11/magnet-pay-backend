/**
 * End-to-end API walkthrough mirroring mobile flows.
 * Run: npx tsx scripts/e2e-walkthrough.ts
 */
import { prisma } from "../src/lib/prisma.js";

const BASE = process.env.API_URL ?? "http://127.0.0.1:4000";
const BUYER_PHONE = "+2348123456789";
const SELLER_PHONE = "+8613800138000";
const PASSCODE = "123456";

type StepResult = { step: string; ok: boolean; detail?: string };

const results: StepResult[] = [];

function pass(step: string, detail?: string) {
  results.push({ step, ok: true, detail });
  console.log(`✓ ${step}${detail ? ` — ${detail}` : ""}`);
}

function fail(step: string, detail: string) {
  results.push({ step, ok: false, detail });
  console.error(`✗ ${step} — ${detail}`);
}

async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json()) as { data?: T; error?: { code: string; message: string } };
  if (!res.ok) {
    throw new Error(`${res.status} ${json.error?.code ?? "ERROR"}: ${json.error?.message ?? res.statusText}`);
  }
  return json.data as T;
}

async function login(phone: string): Promise<{ token: string; userId: string }> {
  const session = await api<{ accessToken: string; user: { id: string } }>("/auth/login", {
    method: "POST",
    body: { phone, passcode: PASSCODE },
  });
  return { token: session.accessToken, userId: session.user.id };
}

async function main() {
  console.log(`\nMagnetPay E2E walkthrough → ${BASE}\n`);

  let buyerToken = "";
  let sellerToken = "";
  let buyerId = "";
  let sellerId = "";
  let productId = "";
  let orderId = "";
  let escrowId = "";
  let quoteId = "";
  let shipmentId = "";
  let failedTransferId = "";

  try {
    const buyer = await login(BUYER_PHONE);
    buyerToken = buyer.token;
    buyerId = buyer.userId;
    pass("1. Buyer login", BUYER_PHONE);

    const seller = await login(SELLER_PHONE);
    sellerToken = seller.token;
    sellerId = seller.userId;
    pass("2. Seller login", SELLER_PHONE);
  } catch (e) {
    fail("Auth", e instanceof Error ? e.message : String(e));
    return summary();
  }

  // ── Market → cart → checkout ──
  try {
    const cart = await api<{ items?: { id: string }[] }>("/market/cart", { token: buyerToken });
    for (const item of cart.items ?? []) {
      await api(`/market/cart/items/${item.id}`, { method: "DELETE", token: buyerToken });
    }

    const products = await api<{ id: string; title: string; priceMinor: string; currency: string }[]>(
      "/market/seller/products",
      { token: sellerToken },
    );
    if (!products.length) throw new Error("Seller has no products");
    productId = products[0].id;
    pass("3. Seller catalog", `${products.length} items · using ${products[0].title.slice(0, 40)}`);

    await api("/market/cart/items", {
      method: "POST",
      token: buyerToken,
      body: { productId, qty: 2 },
    });
    pass("4. Add to cart", `product ${productId.slice(0, 8)} × 2`);

    const order = await api<{ id: string; status: string; totalMinor: string }>("/market/checkout", {
      method: "POST",
      token: buyerToken,
      body: { addressLabel: "Office", addressLine: "12 Marina Rd, Lagos" },
    });
    orderId = order.id;
    pass("5. Checkout", `order ${orderId.slice(0, 8)} · ${order.status} · total ${order.totalMinor}`);
  } catch (e) {
    fail("Market checkout", e instanceof Error ? e.message : String(e));
  }

  // ── Escrow create + fund ──
  try {
    const escrow = await api<{ id: string; status: string }>("/escrow", {
      method: "POST",
      token: buyerToken,
      body: {
        title: "E2E pump bodies",
        amountMinor: "500000",
        currency: "CNY",
        invitePhone: SELLER_PHONE,
        milestones: [
          { label: "Deposit", amountMinor: "150000" },
          { label: "Production", amountMinor: "200000" },
          { label: "Delivery", amountMinor: "150000" },
        ],
      },
    });
    escrowId = escrow.id;
    pass("6. Create escrow", `${escrowId.slice(0, 8)} · ${escrow.status}`);

    const funded = await api<{ id: string; status: string }>(`/escrow/${escrowId}/fund`, {
      method: "POST",
      token: buyerToken,
      body: {},
    });
    pass("7. Fund escrow", funded.status);
  } catch (e) {
    fail("Escrow", e instanceof Error ? e.message : String(e));
  }

  // ── Logistics quote + upload + book ──
  try {
    const quoteRes = await api<{ quote: { id: string; estimatedMinor: string } }>("/logistics/quotes", {
      method: "POST",
      token: buyerToken,
      body: {
        cargoDesc: "Industrial pump parts",
        cbm: 1.2,
        weightKg: 180,
        origin: "Guangzhou",
        destination: "Lagos",
        mode: "SEA",
      },
    });
    quoteId = quoteRes.quote.id;
    pass("8. Request shipping quote", `${quoteId.slice(0, 8)} · est ${quoteRes.quote.estimatedMinor} NGN`);

    const upload = await api<{ url: string; name: string }>("/uploads", {
      method: "POST",
      token: buyerToken,
      body: {
        filename: "commercial-invoice.pdf",
        contentBase64: Buffer.from("E2E test commercial invoice").toString("base64"),
        mimeType: "application/pdf",
      },
    });
    pass("9. Upload booking doc", upload.url);

    const shipment = await api<{ id: string; ref: string; status: string }>(
      `/logistics/quotes/${quoteId}/book`,
      {
        method: "POST",
        token: buyerToken,
        body: {
          documents: [{ kind: "invoice", name: upload.name, url: upload.url }],
        },
      },
    );
    shipmentId = shipment.id;
    pass("10. Book shipment", `${shipment.ref} · ${shipment.status}`);
  } catch (e) {
    fail("Logistics booking", e instanceof Error ? e.message : String(e));
  }

  // ── Seller order documents ──
  try {
    const orders = await api<{ id: string; status: string }[]>("/market/seller/orders", {
      token: sellerToken,
    });
    const targetOrder = orders.find((o) => o.id === orderId) ?? orders[0];
    if (!targetOrder) throw new Error("Seller has no orders");
    if (!orderId) orderId = targetOrder.id;

    const sellerUpload = await api<{ url: string; name: string }>("/uploads", {
      method: "POST",
      token: sellerToken,
      body: {
        filename: "packing-list.pdf",
        contentBase64: Buffer.from("E2E packing list").toString("base64"),
        mimeType: "application/pdf",
      },
    });

    const doc = await api<{ kind: string; name: string; url: string }>(
      `/market/seller/orders/${targetOrder.id}/documents`,
      {
        method: "POST",
        token: sellerToken,
        body: { kind: "packing_list", name: sellerUpload.name, url: sellerUpload.url },
      },
    );
    pass("11. Seller uploads order doc", `${doc.kind} · order ${targetOrder.id.slice(0, 8)}`);

    const docs = await api<unknown[]>(`/market/seller/orders/${targetOrder.id}/documents`, {
      token: sellerToken,
    });
    if (!docs.length) throw new Error("Document not persisted");
    pass("12. Seller lists order docs", `${docs.length} file(s)`);
  } catch (e) {
    fail("Seller order docs", e instanceof Error ? e.message : String(e));
  }

  // ── Transfer retry + refund ──
  try {
    const recipient = await prisma.recipient.findFirst({ where: { userId: buyerId } });
    if (!recipient) throw new Error("No recipient for buyer");

    const failed = await prisma.transfer.create({
      data: {
        senderId: buyerId,
        recipientId: recipient.id,
        currency: "CNY",
        amountMinor: 10000n,
        note: "E2E failed transfer",
        status: "FAILED",
        events: { create: [{ status: "FAILED", message: "Nomba timeout (e2e)" }] },
      },
    });
    failedTransferId = failed.id;

    const retried = await api<{ id: string; status: string }>(`/transfers/${failedTransferId}/retry`, {
      method: "POST",
      token: buyerToken,
      body: {},
    });
    pass("13. Retry failed transfer", `${retried.id.slice(0, 8)} → ${retried.status}`);

    const failed2 = await prisma.transfer.create({
      data: {
        senderId: buyerId,
        recipientId: recipient.id,
        currency: "CNY",
        amountMinor: 5000n,
        note: "E2E refund transfer",
        status: "FAILED",
        events: { create: [{ status: "FAILED", message: "Nomba reject (e2e)" }] },
      },
    });

    const refunded = await api<{ id: string; status: string }>(`/transfers/${failed2.id}/refund`, {
      method: "POST",
      token: buyerToken,
      body: {},
    });
    if (refunded.status !== "REFUNDED") throw new Error(`Expected REFUNDED, got ${refunded.status}`);
    pass("14. Refund failed transfer", `${refunded.id.slice(0, 8)} → ${refunded.status}`);
  } catch (e) {
    fail("Transfer retry/refund", e instanceof Error ? e.message : String(e));
  }

  // ── Bonus sanity checks ──
  try {
    await api("/wallets/fx/quote", {
      method: "POST",
      token: buyerToken,
      body: { from: "CNY", to: "NGN", amountMinor: "10000" },
    });
    pass("15. FX quote", "CNY→NGN");
  } catch (e) {
    fail("FX quote", e instanceof Error ? e.message : String(e));
  }

  try {
    await api("/messages/support", {
      method: "POST",
      token: buyerToken,
      body: { topic: "Other", message: "E2E support ticket smoke test" },
    });
    pass("16. Support ticket", "created");
  } catch (e) {
    fail("Support ticket", e instanceof Error ? e.message : String(e));
  }

  return summary();
}

function summary() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n── Summary: ${passed}/${results.length} passed ──`);
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  • ${f.step}: ${f.detail}`);
    process.exit(1);
  }
  console.log("\nAll flows OK.\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
