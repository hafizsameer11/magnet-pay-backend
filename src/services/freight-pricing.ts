import type { FreightPricing, ShipMode } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const DEFAULT_FREIGHT_PRICING = {
  airBaseMinor: 450_000,
  seaBaseMinor: 180_000,
  expressBaseMinor: 600_000,
  consolidatedBaseMinor: 220_000,
  cbmMultiplier: 100_000,
  weightMultiplier: 2_500,
} as const;

export async function getFreightPricing(): Promise<FreightPricing> {
  const row = await prisma.freightPricing.findUnique({ where: { id: "default" } });
  if (row) return row;
  return prisma.freightPricing.create({
    data: { id: "default", ...DEFAULT_FREIGHT_PRICING },
  });
}

export function estimateFreightMinor(
  cbm: number,
  weightKg: number,
  mode: string,
  config: Pick<
    FreightPricing,
    "airBaseMinor" | "seaBaseMinor" | "expressBaseMinor" | "consolidatedBaseMinor" | "cbmMultiplier" | "weightMultiplier"
  >,
): bigint {
  const base =
    mode === "AIR"
      ? config.airBaseMinor
      : mode === "EXPRESS"
        ? config.expressBaseMinor
        : mode === "SEA"
          ? config.seaBaseMinor
          : config.consolidatedBaseMinor;
  const vol = Math.ceil(cbm * config.cbmMultiplier);
  const w = Math.ceil(weightKg * config.weightMultiplier);
  return BigInt(base + vol + w);
}

export async function estimateQuoteMinor(cbm: number, weightKg: number, mode: ShipMode | string): Promise<bigint> {
  const config = await getFreightPricing();
  return estimateFreightMinor(cbm, weightKg, mode, config);
}
