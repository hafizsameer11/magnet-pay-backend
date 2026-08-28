import { getComplianceLimits } from "./compliance-limits.js";
import { prisma } from "../lib/prisma.js";

export type KycAction =
  | "deposit"
  | "withdraw"
  | "send"
  | "fx_convert"
  | "market_checkout"
  | "logistics_book";

export type KycAccessSnapshot = {
  status: string;
  tier: number;
  approved: boolean;
  effectiveTier: number;
  allowBasicWhilePending: boolean;
  allowed: Record<KycAction, boolean>;
  reasons: Partial<Record<KycAction, string>>;
};

const ACTION_MIN_TIER: Record<KycAction, keyof Awaited<ReturnType<typeof getComplianceLimits>>> = {
  deposit: "minTierDeposit",
  withdraw: "minTierWithdraw",
  send: "minTierCrossBorder",
  fx_convert: "minTierCrossBorder",
  market_checkout: "minTierMarketCheckout",
  logistics_book: "minTierLogistics",
};

const ACTION_LABEL: Record<KycAction, string> = {
  deposit: "deposit funds",
  withdraw: "withdraw funds",
  send: "send cross-border payments",
  fx_convert: "convert currency",
  market_checkout: "place marketplace orders",
  logistics_book: "book shipments",
};

export async function getKycLimitContext(userId: string) {
  const latest = await prisma.kycApplication.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  const approved = latest?.status === "APPROVED";
  const tier = latest?.tier ?? 1;
  return {
    status: latest?.status ?? "DRAFT",
    tier,
    approved,
  };
}

function tierRequirementLabel(minTier: number) {
  if (minTier <= 0) return "";
  if (minTier === 1) return "Tier 1 verification (BVN/NIN)";
  return "Tier 2 verification (photo ID + liveness)";
}

export async function getKycAccess(userId: string): Promise<KycAccessSnapshot> {
  const [kyc, config] = await Promise.all([getKycLimitContext(userId), getComplianceLimits()]);

  let effectiveTier = 0;
  if (kyc.status === "REJECTED") {
    effectiveTier = 0;
  } else if (kyc.approved) {
    effectiveTier = kyc.tier;
  } else if (kyc.status === "SUBMITTED" && config.allowBasicWhilePending) {
    effectiveTier = Math.max(1, kyc.tier);
  }

  const allowed = {} as Record<KycAction, boolean>;
  const reasons: Partial<Record<KycAction, string>> = {};

  for (const action of Object.keys(ACTION_MIN_TIER) as KycAction[]) {
    const minTier = config[ACTION_MIN_TIER[action]] as number;
    if (kyc.status === "REJECTED") {
      allowed[action] = false;
      reasons[action] = "KYC was rejected. Re-upload documents to continue.";
      continue;
    }
    if (effectiveTier >= minTier) {
      allowed[action] = true;
      continue;
    }
    allowed[action] = false;
    if (kyc.status === "SUBMITTED" && config.allowBasicWhilePending && minTier >= 2) {
      reasons[action] = `Waiting for Tier 2 approval before you can ${ACTION_LABEL[action]}.`;
    } else if (!kyc.approved && kyc.status !== "SUBMITTED") {
      reasons[action] = `Complete ${tierRequirementLabel(minTier)} to ${ACTION_LABEL[action]}.`;
    } else {
      reasons[action] = `${tierRequirementLabel(minTier)} is required to ${ACTION_LABEL[action]}.`;
    }
  }

  return {
    status: kyc.status,
    tier: kyc.tier,
    approved: kyc.approved,
    effectiveTier,
    allowBasicWhilePending: config.allowBasicWhilePending,
    allowed,
    reasons,
  };
}

export class KycRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KycRequiredError";
  }
}

export async function assertKycForAction(userId: string, action: KycAction) {
  const access = await getKycAccess(userId);
  if (!access.allowed[action]) {
    throw new KycRequiredError(access.reasons[action] ?? "Identity verification required");
  }
}
