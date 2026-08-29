import { prisma } from "../lib/prisma.js";
import { getParcelTypeByCode } from "./freight-pricing.js";

const SLUG_TO_PARCEL_CODE: Record<string, string> = {
  apparel: "apparel",
  beauty: "apparel",
  electronics: "electronics",
  machinery: "auto_parts",
  industrial: "general",
  home: "home_furniture",
};

export type ParcelTypeSuggestion = {
  parcelTypeId: string;
  code: string;
  name: string;
  source: "product" | "category" | "mixed" | "default";
  reason: string;
};

export async function inferParcelTypeForOrder(orderId: string, userId?: string): Promise<ParcelTypeSuggestion | null> {
  const order = await prisma.marketOrder.findFirst({
    where: { id: orderId, ...(userId ? { userId } : {}) },
    include: {
      items: {
        include: {
          product: {
            include: { category: true, parcelType: true },
          },
        },
      },
    },
  });
  if (!order?.items.length) return null;

  const votes = new Map<string, { weight: number; name: string; code: string; source: ParcelTypeSuggestion["source"] }>();

  for (const item of order.items) {
    const product = item.product;
    if (!product) continue;
    const qty = item.qty;
    const unitWeight = product.weightKgPerUnit && product.weightKgPerUnit > 0 ? product.weightKgPerUnit : 2;
    const weight = qty * unitWeight;

    if (product.parcelTypeId && product.parcelType) {
      const key = product.parcelTypeId;
      const prev = votes.get(key) ?? {
        weight: 0,
        name: product.parcelType.name,
        code: product.parcelType.code,
        source: "product" as const,
      };
      prev.weight += weight;
      votes.set(key, prev);
      continue;
    }

    const catParcelId = product.category?.defaultParcelTypeId;
    if (catParcelId) {
      const pt = await prisma.parcelType.findUnique({ where: { id: catParcelId } });
      if (pt) {
        const key = pt.id;
        const prev = votes.get(key) ?? { weight: 0, name: pt.name, code: pt.code, source: "category" as const };
        prev.weight += weight;
        votes.set(key, prev);
        continue;
      }
    }

    const slug = product.category?.slug;
    const code = slug ? SLUG_TO_PARCEL_CODE[slug] : undefined;
    if (code) {
      const pt = await getParcelTypeByCode(code);
      if (pt) {
        const key = pt.id;
        const prev = votes.get(key) ?? { weight: 0, name: pt.name, code: pt.code, source: "category" as const };
        prev.weight += weight;
        votes.set(key, prev);
      }
    }
  }

  if (!votes.size) {
    const general = await getParcelTypeByCode("general");
    if (!general) return null;
    return {
      parcelTypeId: general.id,
      code: general.code,
      name: general.name,
      source: "default",
      reason: "No product parcel type set — using general goods",
    };
  }

  const sorted = [...votes.entries()].sort((a, b) => b[1].weight - a[1].weight);
  const [topId, top] = sorted[0]!;
  const source: ParcelTypeSuggestion["source"] =
    sorted.length > 1 && sorted[1]![1].weight > top.weight * 0.4 ? "mixed" : top.source;

  return {
    parcelTypeId: topId,
    code: top.code,
    name: top.name,
    source,
    reason:
      source === "product"
        ? `From seller product listing (${top.name})`
        : source === "category"
          ? `From product category (${top.name})`
          : source === "mixed"
            ? `Mixed order — dominant type: ${top.name}. You can change before booking.`
            : `Default: ${top.name}`,
  };
}
