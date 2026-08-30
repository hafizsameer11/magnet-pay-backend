import type { ComplianceLimits } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const DEFAULT_COMPLIANCE_LIMITS = {
  unverifiedNgnDailyCapMinor: 0,
  ngnTier1DailyCapMinor: 500_000_00,
  ngnTier2DailyCapMinor: 20_000_000_00,
  cnyDailyCapMinor: 200_000_00,
  minTierDeposit: 1,
  minTierWithdraw: 1,
  minTierCrossBorder: 1,
  minTierMarketCheckout: 1,
  minTierLogistics: 1,
  allowBasicWhilePending: true,
} as const;

export async function getComplianceLimits(): Promise<ComplianceLimits> {
  const existing = await prisma.complianceLimits.findUnique({ where: { id: "default" } });
  if (existing) return existing;
  return prisma.complianceLimits.create({
    data: { id: "default", ...DEFAULT_COMPLIANCE_LIMITS },
  });
}

export type ComplianceLimitsInput = Omit<ComplianceLimits, "id" | "updatedAt">;

export async function updateComplianceLimits(input: ComplianceLimitsInput) {
  return prisma.complianceLimits.upsert({
    where: { id: "default" },
    create: { id: "default", ...input },
    update: input,
  });
}
