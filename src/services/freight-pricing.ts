import type { FreightPricing, ParcelType, ShipMode } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const DEFAULT_FREIGHT_PRICING = {
  airBaseMinor: 450_000,
  seaBaseMinor: 180_000,
  expressBaseMinor: 600_000,
  consolidatedBaseMinor: 220_000,
  cbmMultiplier: 100_000,
  weightMultiplier: 2_500,
} as const;

export const DEFAULT_ESTIMATE_DISCLAIMER =
  "This is an estimate, not the final price. Final cost is set when goods clear customs. Any difference is credited to your ₦ wallet or requires top-up before collection.";

export async function getFreightPricing(): Promise<FreightPricing> {
  const row = await prisma.freightPricing.findUnique({ where: { id: "default" } });
  if (row) return row;
  return prisma.freightPricing.create({
    data: { id: "default", ...DEFAULT_FREIGHT_PRICING },
  });
}

export async function getLogisticsEstimateConfig() {
  const row = await prisma.logisticsEstimateConfig.findUnique({ where: { id: "default" } });
  if (row) return row;
  return prisma.logisticsEstimateConfig.create({
    data: { id: "default", usdNgnEstimateRate: 165_000, estimateDisclaimer: DEFAULT_ESTIMATE_DISCLAIMER },
  });
}

export async function listActiveParcelTypes(): Promise<ParcelType[]> {
  return prisma.parcelType.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function getParcelTypeById(id: string): Promise<ParcelType | null> {
  return prisma.parcelType.findFirst({ where: { id, active: true } });
}

export async function getParcelTypeByCode(code: string): Promise<ParcelType | null> {
  return prisma.parcelType.findFirst({ where: { code, active: true } });
}

/** Parcel-type estimate: base + ceil(kg × rate/kg) */
export function estimateParcelTypeMinor(
  weightKg: number,
  parcelType: Pick<ParcelType, "baseMinor" | "ratePerKgMinor">,
): bigint {
  const weightCharge = Math.ceil(weightKg * parcelType.ratePerKgMinor);
  return BigInt(parcelType.baseMinor + weightCharge);
}

/** Display-only duty hint — excluded from hold until admin settles */
export function estimateDutyHintMinor(declaredUsd: number, usdNgnRate: number): bigint {
  if (declaredUsd <= 0) return 0n;
  return BigInt(Math.ceil(declaredUsd * usdNgnRate));
}

/** @deprecated Legacy CBM formula — kept for migration reference only */
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

export type EstimateBreakdown = {
  baseMinor: bigint;
  weightChargeMinor: bigint;
  estimatedMinor: bigint;
  dutyHintMinor?: bigint;
  formula: string;
};

export async function estimateQuoteFromParcelType(input: {
  parcelTypeId: string;
  weightKg: number;
  declaredUsd?: number;
}): Promise<EstimateBreakdown & { parcelType: ParcelType }> {
  const parcelType = await getParcelTypeById(input.parcelTypeId);
  if (!parcelType) throw new Error("Parcel type not found");

  const weightChargeMinor = BigInt(Math.ceil(input.weightKg * parcelType.ratePerKgMinor));
  const baseMinor = BigInt(parcelType.baseMinor);
  const estimatedMinor = baseMinor + weightChargeMinor;

  const config = await getLogisticsEstimateConfig();
  const dutyHintMinor =
    input.declaredUsd != null && input.declaredUsd > 0
      ? estimateDutyHintMinor(input.declaredUsd, config.usdNgnEstimateRate)
      : undefined;

  return {
    parcelType,
    baseMinor,
    weightChargeMinor,
    estimatedMinor,
    dutyHintMinor,
    formula: `${parcelType.name}: base + ceil(${input.weightKg}kg × ₦${(parcelType.ratePerKgMinor / 100).toLocaleString()}/kg)`,
  };
}

export async function estimateQuoteMinor(
  parcelTypeId: string,
  weightKg: number,
  _mode?: ShipMode | string,
  declaredUsd?: number,
): Promise<bigint> {
  const result = await estimateQuoteFromParcelType({ parcelTypeId, weightKg, declaredUsd });
  return result.estimatedMinor;
}
