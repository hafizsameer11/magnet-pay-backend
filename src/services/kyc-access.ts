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

/** Buyers have one verification level: BVN/NIN (Prembly). Tier 2 / liveness is not used. */
function buyerMinTier(raw: number) {
  return raw <= 0 ? 0 : 1;
}

export async function getKycLimitContext(userId: string) {
  const latest = await prisma.kycApplication.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  const approved = latest?.status === "APPROVED";
  const tier = approved ? 1 : (latest?.tier ?? 0);
  return {
    status: latest?.status ?? "DRAFT",
    tier,
    approved,
  };
}

export async function getKycAccess(userId: string): Promise<KycAccessSnapshot> {
  const [kyc, config] = await Promise.all([getKycLimitContext(userId), getComplianceLimits()]);

  let effectiveTier = 0;
  if (kyc.status === "REJECTED") {
    effectiveTier = 0;
  } else if (kyc.approved) {
    effectiveTier = 1;
  } else if (kyc.status === "SUBMITTED" && config.allowBasicWhilePending) {
    effectiveTier = 1;
  }

  const allowed = {} as Record<KycAction, boolean>;
  const reasons: Partial<Record<KycAction, string>> = {};

  for (const action of Object.keys(ACTION_MIN_TIER) as KycAction[]) {
    const minTier = buyerMinTier(config[ACTION_MIN_TIER[action]] as number);
    if (kyc.status === "REJECTED") {
      allowed[action] = false;
      reasons[action] = "KYC was rejected. Re-submit your BVN or NIN to continue.";
      continue;
    }
    if (effectiveTier >= minTier) {
      allowed[action] = true;
      continue;
    }
    allowed[action] = false;
    if (!kyc.approved && kyc.status !== "SUBMITTED") {
      reasons[action] = `Complete BVN/NIN verification to ${ACTION_LABEL[action]}.`;
    } else {
      reasons[action] = `BVN/NIN verification is required to ${ACTION_LABEL[action]}.`;
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
    throw new KycRequiredError(access.reasons[action] ?? "BVN/NIN verification required");
  }
}
