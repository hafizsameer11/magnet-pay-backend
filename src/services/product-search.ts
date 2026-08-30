import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export type ProductSearchFilters = {
  q?: string;
  category?: string;
  storeId?: string;
  price?: string;
  moqMax?: number;
  ratingMin?: number;
  incoterm?: string;
};

function priceRangeToMinor(price: string): Prisma.BigIntFilter | null {
  if (!price || price === "any") return null;
  switch (price) {
    case "lt10":
      return { lt: 1000n };
    case "10-100":
      return { gte: 1000n, lte: 10000n };
    case "100-500":
      return { gte: 1000n, lte: 50000n };
    case "500+":
      return { gt: 50000n };
    default:
      return null;
  }
}

/** First digit run in moq strings like "50 units" or "5,000 pcs" (matches mobile parseMoq). */
export async function productIdsWithinMoqMax(moqMax: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM Product
    WHERE REGEXP_SUBSTR(moq, '[0-9]+') IS NOT NULL
      AND CAST(REGEXP_SUBSTR(moq, '[0-9]+') AS UNSIGNED) <= ${moqMax}
  `;
  return rows.map((r) => r.id);
}

export function buildProductSearchWhere(
  filters: ProductSearchFilters,
  moqIds?: string[],
): Prisma.ProductWhereInput {
  const priceMinor = filters.price ? priceRangeToMinor(filters.price) : null;
  return {
    active: true,
    store: { verified: true },
    ...(filters.q ? { title: { contains: filters.q } } : {}),
    ...(filters.category ? { category: { slug: filters.category } } : {}),
    ...(filters.storeId ? { storeId: filters.storeId } : {}),
    ...(filters.ratingMin != null ? { rating: { gte: filters.ratingMin } } : {}),
    ...(filters.incoterm ? { defaultIncoterm: filters.incoterm.toUpperCase() } : {}),
    ...(priceMinor ? { priceMinor } : {}),
    ...(moqIds ? { id: { in: moqIds } } : {}),
  };
}

export async function searchProducts(filters: ProductSearchFilters, take = 50) {
  let moqIds: string[] | undefined;
  if (filters.moqMax != null) {
    moqIds = await productIdsWithinMoqMax(filters.moqMax);
    if (moqIds.length === 0) return [];
  }

  return prisma.product.findMany({
    where: buildProductSearchWhere(filters, moqIds),
    include: { store: true, category: true },
    take,
    orderBy: filters.q ? { title: "asc" } : { createdAt: "desc" },
  });
}

export function parseProductSearchQuery(query: Record<string, unknown>): ProductSearchFilters {
  const str = (key: string) => (typeof query[key] === "string" ? query[key] : undefined);

  const q = str("q");
  const category = str("category");
  const storeId = str("storeId");
  const priceRaw = str("price");
  const moqRaw = str("moqMax") ?? str("moq");
  const ratingRaw = str("ratingMin") ?? str("rating");
  const incotermRaw = str("incoterm");

  const moqMax = moqRaw && moqRaw !== "any" ? Number(moqRaw) : undefined;
  const ratingMin = ratingRaw && ratingRaw !== "any" ? Number(ratingRaw) : undefined;

  return {
    q,
    category,
    storeId,
    price: priceRaw && priceRaw !== "any" ? priceRaw : undefined,
    moqMax: Number.isFinite(moqMax) ? moqMax : undefined,
    ratingMin: Number.isFinite(ratingMin) ? ratingMin : undefined,
    incoterm: incotermRaw && incotermRaw !== "any" ? incotermRaw : undefined,
  };
}
