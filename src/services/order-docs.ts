import { prisma } from "../lib/prisma.js";

export type OrderDocRow = { kind: string; name: string; url: string; uploadedAt?: string };

export const REQUIRED_SELLER_DOC_KINDS = ["bl", "pl", "ci", "co"] as const;

export const BOOKING_DOC_KINDS = ["ci", "pl"] as const;

type SellerMeta = {
  orderDocs?: Record<string, OrderDocRow[]>;
  orderDocPackageSent?: Record<string, string>;
};

async function sellerMeta(userId: string): Promise<SellerMeta> {
  const bp = await prisma.businessProfile.findUnique({ where: { userId } });
  return (bp?.documents as SellerMeta | null) ?? {};
}

export async function saveSellerMeta(userId: string, patch: Partial<SellerMeta>) {
  const existing = await sellerMeta(userId);
  const merged = { ...existing, ...patch };
  await prisma.businessProfile.upsert({
    where: { userId },
    create: { userId, companyName: "Seller", documents: merged, status: "DRAFT" },
    update: { documents: merged },
  });
  return merged;
}

export async function orderDocumentsForSeller(sellerUserId: string, orderId: string) {
  const meta = await sellerMeta(sellerUserId);
  const all = meta.orderDocs ?? {};
  return {
    documents: all[orderId] ?? [],
    packageSentAt: meta.orderDocPackageSent?.[orderId] ?? null,
  };
}

export async function orderDocumentsForBuyer(orderId: string) {
  const order = await prisma.marketOrder.findUnique({ where: { id: orderId } });
  if (!order) return { documents: [] as OrderDocRow[], packageSentAt: null as string | null };

  const store = await prisma.sellerStore.findFirst({
    where: { OR: [{ id: order.supplier }, { name: order.supplier }] },
  });
  if (!store) return { documents: [], packageSentAt: null };

  return orderDocumentsForSeller(store.userId, orderId);
}

export function mapSellerDocKindToShipment(kind: string) {
  const map: Record<string, string> = {
    ci: "ci",
    pl: "pl",
    bl: "bl",
    co: "co",
    sgs: "sgs",
  };
  return map[kind] ?? kind;
}

/** Merge seller order docs into booking docs when linked to a market order. */
export async function mergeSellerDocsIntoBooking(
  orderId: string,
  submitted: { kind: string; name: string; url: string }[],
) {
  const { documents: sellerDocs } = await orderDocumentsForBuyer(orderId);
  if (!sellerDocs.length) return submitted;

  const seen = new Set(submitted.map((d) => d.kind));
  const merged = [...submitted];
  for (const doc of sellerDocs) {
    const kind = mapSellerDocKindToShipment(doc.kind);
    if (seen.has(kind)) continue;
    merged.push({
      kind,
      name: doc.name,
      url: doc.url,
    });
    seen.add(kind);
  }
  return merged;
}
