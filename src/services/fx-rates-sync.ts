import { prisma } from "../lib/prisma.js";

/** FeeConfig stores FX as integer = rate × 10_000 (229.04 → 2_290_400). */
export function feeConfigValueToRate(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value / 10_000;
}

export function rateToFeeConfigValue(rate: number): number {
  return Math.round(rate * 10_000);
}

/** Map admin FeeConfig keys to FxRate pair ids. */
export function feeConfigKeyToPair(key: string): string | null {
  const raw = key.replace(/^fx\./i, "").trim();
  if (!raw || raw.includes("spread")) return null;
  const normalized = raw.toUpperCase().replace(/-/g, "_");
  if (/^[A-Z]{3}_[A-Z]{3}$/.test(normalized)) return normalized;
  return null;
}

export const DEFAULT_FX_FEE_CONFIG: { key: string; value: number }[] = [
  { key: "fx.CNY_NGN", value: 2_290_400 },
  { key: "fx.NGN_CNY", value: 44 },
  { key: "fx.USD_NGN", value: 15_400_000 },
  { key: "fx.NGN_USD", value: 7 },
  { key: "fx.USD_CNY", value: 72_000 },
  { key: "fx.CNY_USD", value: 1_390 },
  { key: "escrow_fee_bps", value: 90 },
];

export async function ensureDefaultFxFeeConfig() {
  for (const row of DEFAULT_FX_FEE_CONFIG) {
    await prisma.feeConfig.upsert({
      where: { key: row.key },
      create: row,
      update: {},
    });
  }
}

/** Push admin FeeConfig fx.* values into the FxRate table used by mobile quotes. */
export async function syncFeeConfigRatesToFxTable() {
  const rows = await prisma.feeConfig.findMany({
    where: { key: { startsWith: "fx." } },
  });

  const spreadRow = await prisma.feeConfig.findUnique({ where: { key: "fx.spread_bps" } });
  const spreadBps = spreadRow?.value ?? 50;

  let synced = 0;
  for (const row of rows) {
    const pair = feeConfigKeyToPair(row.key);
    if (!pair) continue;
    const rate = feeConfigValueToRate(row.value);
    if (rate <= 0) continue;
    await prisma.fxRate.upsert({
      where: { pair },
      create: { pair, rate, spreadBps },
      update: { rate, spreadBps },
    });
    synced += 1;
  }
  return synced;
}

/** Seed FeeConfig from existing FxRate rows when admin keys are missing. */
export async function syncFxTableToFeeConfig() {
  const rates = await prisma.fxRate.findMany();
  for (const row of rates) {
    const key = `fx.${row.pair}`;
    await prisma.feeConfig.upsert({
      where: { key },
      create: { key, value: rateToFeeConfigValue(Number(row.rate)) },
      update: {},
    });
  }
}

/** Primary admin desk pairs (display order). */
export const ADMIN_FX_DISPLAY_PAIRS: {
  pair: string;
  rate: number;
  spreadBps: number;
  source: "Wise" | "CBN" | "Manual" | "Alipay";
}[] = [
  { pair: "CNY_NGN", rate: 229.04, spreadBps: 180, source: "Wise" },
  { pair: "USD_NGN", rate: 1620, spreadBps: 120, source: "CBN" },
  { pair: "CNY_USD", rate: 0.1413, spreadBps: 40, source: "Wise" },
  { pair: "GHS_NGN", rate: 108.42, spreadBps: 250, source: "Manual" },
  { pair: "KES_NGN", rate: 12.41, spreadBps: 200, source: "Manual" },
  { pair: "USD_CNY", rate: 7.078, spreadBps: 40, source: "Wise" },
];

export function pairToDisplay(pair: string) {
  return pair.replace("_", "/");
}

export function spreadPctFromBps(bps: number) {
  return bps / 100;
}

export function buySellFromMid(mid: number, spreadBps: number) {
  const half = mid * (spreadBps / 10_000 / 2);
  return { buy: mid - half, sell: mid + half };
}

export async function ensureAdminFxDisplayPairs() {
  for (const row of ADMIN_FX_DISPLAY_PAIRS) {
    await prisma.fxRate.upsert({
      where: { pair: row.pair },
      create: { pair: row.pair, rate: row.rate, spreadBps: row.spreadBps },
      update: {},
    });
    await prisma.feeConfig.upsert({
      where: { key: `fx.${row.pair}` },
      create: { key: `fx.${row.pair}`, value: rateToFeeConfigValue(row.rate) },
      update: {},
    });
    if (row.source === "Manual") {
      await prisma.feeConfig.upsert({
        where: { key: `fx.manual.${row.pair}` },
        create: { key: `fx.manual.${row.pair}`, value: 1 },
        update: {},
      });
    }
  }
}

export async function listAdminFxPairs() {
  await ensureDefaultFxFeeConfig();
  await ensureAdminFxDisplayPairs();

  const order = ADMIN_FX_DISPLAY_PAIRS.map((p) => p.pair);
  const rates = await prisma.fxRate.findMany({ where: { pair: { in: order } } });
  const manualRows = await prisma.feeConfig.findMany({ where: { key: { startsWith: "fx.manual." } } });
  const manualSet = new Set(
    manualRows.filter((r) => r.value === 1).map((r) => r.key.replace(/^fx\.manual\./i, "")),
  );
  const sourceByPair = Object.fromEntries(ADMIN_FX_DISPLAY_PAIRS.map((p) => [p.pair, p.source]));

  const byPair = new Map(rates.map((r) => [r.pair, r]));
  return order.map((pairKey) => {
    const row = byPair.get(pairKey);
    const mid = row ? Number(row.rate) : 0;
    const spreadBps = row?.spreadBps ?? 50;
    const override = manualSet.has(pairKey);
    const { buy, sell } = buySellFromMid(mid, spreadBps);
    return {
      pair: pairToDisplay(pairKey),
      pairKey,
      mid,
      buy,
      sell,
      spreadPct: spreadPctFromBps(spreadBps),
      source: override ? "Manual" : (sourceByPair[pairKey] ?? "Wise"),
      override,
      updatedAt: row?.updatedAt?.toISOString() ?? new Date().toISOString(),
    };
  });
}
