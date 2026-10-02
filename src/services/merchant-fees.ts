import { prisma } from "../lib/prisma.js";

/**
 * Platform fee for a merchant service.
 * MerchantFeeRule.value:
 *  - feeType "percent": basis points where 50 = 0.5% (amount * value / 10000)
 *  - feeType "flat": minor units (kobo)
 */
export async function platformFee(service: string, amountMinor: number | bigint): Promise<bigint> {
  const amt = typeof amountMinor === "bigint" ? Number(amountMinor) : amountMinor;
  const rules = await prisma.merchantFeeRule.findMany({
    where: { service },
    orderBy: [{ version: "desc" }, { effectiveFrom: "desc" }],
  });

  const match = rules.find((r) => {
    if (amt < r.minAmount) return false;
    if (r.maxAmount != null && amt > r.maxAmount) return false;
    return true;
  });

  if (!match) return 0n;

  if (match.feeType === "percent") {
    // value is basis points: 50 → 0.5%
    return BigInt(Math.round((amt * match.value) / 10000));
  }

  return BigInt(match.value);
}

export async function quotePlatformAndAgent(
  service: string,
  amountMinor: number | bigint,
  agentFeeOverride?: number | bigint | null,
) {
  const platform = await platformFee(service, amountMinor);
  const agent =
    agentFeeOverride != null
      ? typeof agentFeeOverride === "bigint"
        ? agentFeeOverride
        : BigInt(agentFeeOverride)
      : platform;
  const amount = typeof amountMinor === "bigint" ? amountMinor : BigInt(amountMinor);
  return {
    amountMinor: amount,
    platformFeeMinor: platform,
    agentFeeMinor: agent,
    customerTotalMinor: amount + platform + agent,
  };
}
