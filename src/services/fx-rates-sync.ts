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
