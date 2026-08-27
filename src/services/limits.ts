import type { Currency } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { formatMoney } from "./ledger.js";

const NGN_TIER1_CAP = 500_000_00n;
const NGN_TIER2_CAP = 20_000_000_00n;
const CNY_DAILY_CAP = 200_000_00n;

export type LimitKind = "deposit" | "withdraw" | "send";

export function startOfUtcDay() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

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

export function ngnDailyCapMinor(kyc: { approved: boolean; tier: number }) {
  if (kyc.approved && kyc.tier >= 2) return NGN_TIER2_CAP;
  return NGN_TIER1_CAP;
}

export function cnyDailyCapMinor() {
  return CNY_DAILY_CAP;
}

async function sumDepositsToday(userId: string, currency: Currency) {
  const agg = await prisma.deposit.aggregate({
    where: {
      userId,
      currency,
      status: "SUCCEEDED",
      createdAt: { gte: startOfUtcDay() },
    },
    _sum: { amountMinor: true },
  });
  return agg._sum.amountMinor ?? 0n;
}

async function sumWithdrawalsToday(userId: string, currency: Currency) {
  const agg = await prisma.withdrawal.aggregate({
    where: {
      userId,
      currency,
      status: "SUCCEEDED",
      createdAt: { gte: startOfUtcDay() },
    },
    _sum: { amountMinor: true },
  });
  return agg._sum.amountMinor ?? 0n;
}

async function sumTransfersToday(userId: string, currency: Currency) {
  const agg = await prisma.transfer.aggregate({
    where: {
      senderId: userId,
      currency,
      status: { in: ["PROCESSING", "SUCCEEDED"] },
      createdAt: { gte: startOfUtcDay() },
    },
    _sum: { amountMinor: true },
  });
  return agg._sum.amountMinor ?? 0n;
}

function limitRow(currency: Currency, capMinor: bigint, usedMinor: bigint) {
  const remainingMinor = capMinor > usedMinor ? capMinor - usedMinor : 0n;
  return {
    dailyCapMinor: capMinor.toString(),
    usedTodayMinor: usedMinor.toString(),
    remainingMinor: remainingMinor.toString(),
    displayCap: formatMoney(currency, capMinor),
    displayUsed: formatMoney(currency, usedMinor),
    displayRemaining: formatMoney(currency, remainingMinor),
  };
}

export async function getWalletLimits(userId: string) {
  const kyc = await getKycLimitContext(userId);
  const ngnCap = ngnDailyCapMinor(kyc);
  const cnyCap = cnyDailyCapMinor();

  const [ngnDepUsed, ngnWdUsed, cnySendUsed, cnyWdUsed] = await Promise.all([
    sumDepositsToday(userId, "NGN"),
    sumWithdrawalsToday(userId, "NGN"),
    sumTransfersToday(userId, "CNY"),
    sumWithdrawalsToday(userId, "CNY"),
  ]);

  return {
    kyc,
    ngn: {
      deposit: limitRow("NGN", ngnCap, ngnDepUsed),
      withdraw: limitRow("NGN", ngnCap, ngnWdUsed),
    },
    cny: {
      send: limitRow("CNY", cnyCap, cnySendUsed),
      withdraw: limitRow("CNY", cnyCap, cnyWdUsed),
    },
  };
}

export async function assertWithinDailyLimit(
  userId: string,
  kind: LimitKind,
  currency: Currency,
  amountMinor: bigint,
) {
  if (amountMinor <= 0n) return;
  const limits = await getWalletLimits(userId);

  let capMinor: bigint;
  let usedMinor: bigint;
  let label: string;

  if (currency === "NGN" && kind === "deposit") {
    capMinor = BigInt(limits.ngn.deposit.dailyCapMinor);
    usedMinor = BigInt(limits.ngn.deposit.usedTodayMinor);
    label = "NGN deposit";
  } else if (currency === "NGN" && kind === "withdraw") {
    capMinor = BigInt(limits.ngn.withdraw.dailyCapMinor);
    usedMinor = BigInt(limits.ngn.withdraw.usedTodayMinor);
    label = "NGN withdrawal";
  } else if (currency === "CNY" && kind === "send") {
    capMinor = BigInt(limits.cny.send.dailyCapMinor);
    usedMinor = BigInt(limits.cny.send.usedTodayMinor);
    label = "CNY send";
  } else if (currency === "CNY" && kind === "withdraw") {
    capMinor = BigInt(limits.cny.withdraw.dailyCapMinor);
    usedMinor = BigInt(limits.cny.withdraw.usedTodayMinor);
    label = "CNY withdrawal";
  } else {
    return;
  }

  const remaining = capMinor > usedMinor ? capMinor - usedMinor : 0n;
  if (amountMinor > remaining) {
    throw new Error(
      `Daily ${label} limit exceeded · remaining ${formatMoney(currency, remaining)} · requested ${formatMoney(currency, amountMinor)}`,
    );
  }
}
