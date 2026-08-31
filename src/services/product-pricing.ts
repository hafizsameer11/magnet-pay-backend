type PricingTierRow = { from: string; to?: string; priceMinor: string | number };

function tierFromQty(from: string) {
  const n = parseInt(String(from || "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function tierToQty(to?: string) {
  if (!to?.trim() || to.trim() === "+") return Number.POSITIVE_INFINITY;
  const n = parseInt(String(to).replace(/\D/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}

export function parseProductMoq(moq?: string | null) {
  const n = Number(String(moq || "1").replace(/\D/g, ""));
  return n > 0 ? n : 1;
}

function parseMoq(moq?: string | null) {
  return parseProductMoq(moq);
}

function normalizePricingTiers(raw: unknown): PricingTierRow[] {
  let rows: unknown = raw;
  if (typeof raw === "string") {
    try {
      rows = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .map((t) => {
      if (!t || typeof t !== "object") return null;
      const row = t as Record<string, unknown>;
      let priceMinor = row.priceMinor;
      if ((priceMinor === undefined || priceMinor === null || priceMinor === "") && row.price != null && row.price !== "") {
        const major = parseFloat(String(row.price));
        if (Number.isFinite(major)) priceMinor = Math.round(major * 100);
      }
      if (priceMinor === undefined || priceMinor === null || priceMinor === "") return null;
      const minorNum = typeof priceMinor === "number" ? priceMinor : parseFloat(String(priceMinor));
      if (!Number.isFinite(minorNum) || minorNum <= 0) return null;
      return {
        from: String(row.from ?? ""),
        to: row.to != null && String(row.to).trim() !== "" ? String(row.to) : undefined,
        priceMinor: typeof priceMinor === "number" ? priceMinor : String(priceMinor),
      };
    })
    .filter((t): t is PricingTierRow => t != null);
}

export function tierForQty(qty: number, tiers: PricingTierRow[], fallbackFrom = 1) {
  if (!tiers.length) return null;
  let best: PricingTierRow | null = null;
  let bestFrom = -1;
  for (const tier of tiers) {
    const from = tierFromQty(tier.from || String(fallbackFrom)) || fallbackFrom;
    const to = tierToQty(tier.to);
    if (qty >= from && qty <= to && from >= bestFrom) {
      best = tier;
      bestFrom = from;
    }
  }
  if (best) return best;
  const sorted = [...tiers].sort(
    (a, b) => tierFromQty(a.from || String(fallbackFrom)) - tierFromQty(b.from || String(fallbackFrom)),
  );
  return sorted[sorted.length - 1] ?? null;
}

export function unitMinorForProduct(
  product: { priceMinor: bigint; pricingTiers?: unknown; moq?: string | null },
  qty: number,
  variant?: { priceMinor: bigint } | null,
): bigint {
  const tiers = normalizePricingTiers(product.pricingTiers);
  const tier = tiers.length ? tierForQty(qty, tiers, parseMoq(product.moq)) : null;
  if (tier) return BigInt(tier.priceMinor);
  if (variant) return variant.priceMinor;
  return product.priceMinor;
}
