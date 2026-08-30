import type { Currency, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { creditWallet, debitWallet, formatMoney, recordTx } from "./ledger.js";

const NGN_PER_CNY = 229.04;
const NGN_PER_USD = 1620;

export type WalletAccessStatus = "active" | "limited" | "frozen";

export type AdminWalletRow = {
  id: string;
  currency: Currency;
  balanceMinor: bigint;
  holdMinor: bigint;
  availableMinor: bigint;
  updatedAt: Date;
};

function toNgnEstimate(currency: Currency, minor: bigint) {
  const major = Number(minor) / 100;
  if (currency === "NGN") return major;
  if (currency === "CNY") return major * NGN_PER_CNY;
  if (currency === "USD") return major * NGN_PER_USD;
  return major;
}

export async function resolveWalletAccessStatus(userId: string): Promise<WalletAccessStatus> {
  const suspend = await prisma.auditLog.findFirst({
    where: {
      entity: "user",
      entityId: userId,
      action: { in: ["user.suspend", "user.unsuspend"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (suspend?.action === "user.suspend") return "frozen";

  const kyc = await prisma.kycApplication.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  if (!kyc || kyc.status !== "APPROVED") return "limited";
  return "active";
}

async function escrowHeldByCurrency(userId: string) {
  const milestones = await prisma.escrowMilestone.findMany({
    where: { status: "FUNDED", escrow: { buyerId: userId } },
    include: { escrow: { select: { currency: true } } },
  });
  const map = new Map<Currency, bigint>();
  for (const m of milestones) {
    const c = m.escrow.currency;
    map.set(c, (map.get(c) ?? 0n) + m.amountMinor);
  }
  return map;
}

async function lifetimeDepositsByCurrency(userId: string) {
  const rows = await prisma.deposit.groupBy({
    by: ["currency"],
    where: { userId, status: "SUCCEEDED" },
    _sum: { amountMinor: true },
  });
  const map = new Map<Currency, bigint>();
  for (const r of rows) {
    if (r._sum.amountMinor) map.set(r.currency, r._sum.amountMinor);
  }
  return map;
}

function mapWalletRows(
  wallets: { id: string; currency: Currency; balanceMinor: bigint; holdMinor: bigint; updatedAt: Date }[],
): AdminWalletRow[] {
  return wallets.map((w) => ({
    id: w.id,
    currency: w.currency,
    balanceMinor: w.balanceMinor,
    holdMinor: w.holdMinor,
    availableMinor: w.balanceMinor - w.holdMinor,
    updatedAt: w.updatedAt,
  }));
}

export async function buildWalletUserSummary(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      role: true,
      createdAt: true,
      wallets: { orderBy: { currency: "asc" } },
    },
  });
  if (!user) return null;

  const [status, escrowMap, lifetimeMap, txns30d, lastTxn] = await Promise.all([
    resolveWalletAccessStatus(userId),
    escrowHeldByCurrency(userId),
    lifetimeDepositsByCurrency(userId),
    prisma.transaction.count({
      where: { userId, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    }),
    prisma.transaction.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, title: true, kind: true },
    }),
  ]);

  const wallets = mapWalletRows(user.wallets);
  const totalHoldMinor = wallets.reduce((s, w) => s + w.holdMinor, 0n);
  let escrowMinorNgn = 0;
  for (const [currency, minor] of escrowMap) {
    escrowMinorNgn += toNgnEstimate(currency, minor);
  }
  let lifetimeMinorNgn = 0;
  for (const [currency, minor] of lifetimeMap) {
    lifetimeMinorNgn += toNgnEstimate(currency, minor);
  }

  return {
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    },
    status,
    wallets,
    stats: {
      currencyCount: wallets.length,
      totalHoldMinor: totalHoldMinor.toString(),
      escrowMinorNgn: Math.round(escrowMinorNgn * 100),
      lifetimeMinorNgn: Math.round(lifetimeMinorNgn * 100),
      txns30d,
      lastTxnAt: lastTxn?.createdAt ?? null,
      lastTxnTitle: lastTxn?.title ?? null,
    },
  };
}

export async function listWalletHolders() {
  const walletRows = await prisma.wallet.findMany({
    include: {
      user: {
        select: { id: true, name: true, phone: true, email: true, role: true, createdAt: true },
      },
    },
    orderBy: [{ user: { name: "asc" } }, { currency: "asc" }],
    take: 500,
  });

  const byUser = new Map<string, typeof walletRows>();
  for (const row of walletRows) {
    const list = byUser.get(row.userId) ?? [];
    list.push(row);
    byUser.set(row.userId, list);
  }

  const holders = [];
  for (const [userId, rows] of byUser) {
    const summary = await buildWalletUserSummary(userId);
    if (!summary) continue;
    holders.push(summary);
  }

  holders.sort((a, b) => a.user.name.localeCompare(b.user.name));
  return holders;
}

function isPlatformHolder(user: { name: string }) {
  const n = user.name.toLowerCase();
  return (
    n.includes("magnetpay fees") ||
    n.includes("magnetpay escrow") ||
    n.includes("magnetpay treasury") ||
    n.includes("liquidity bot")
  );
}

export async function getWalletAdminOverview() {
  const holders = await listWalletHolders();

  let totalNgnMinor = 0n;
  let totalCnyMinor = 0n;
  let totalUsdMinor = 0n;
  let walletCount = 0;
  let escrowMinorNgn = 0;
  let frozenCount = 0;
  let limitedCount = 0;

  const platformWallets = [];
  const userHolders = [];

  for (const h of holders) {
    walletCount += h.wallets.length;
    escrowMinorNgn += Number(h.stats.escrowMinorNgn);
    if (h.status === "frozen") frozenCount++;
    if (h.status === "limited") limitedCount++;

    for (const w of h.wallets) {
      const bal = BigInt(w.balanceMinor);
      if (w.currency === "NGN") totalNgnMinor += bal;
      else if (w.currency === "CNY") totalCnyMinor += bal;
      else if (w.currency === "USD") totalUsdMinor += bal;
    }

    if (isPlatformHolder(h.user)) platformWallets.push(h);
    else userHolders.push(h);
  }

  return {
    summary: {
      totalNgnMinor: totalNgnMinor.toString(),
      totalCnyMinor: totalCnyMinor.toString(),
      totalUsdMinor: totalUsdMinor.toString(),
      walletCount,
      escrowMinorNgn,
      frozenCount,
      limitedCount,
      holderCount: userHolders.length,
    },
    platformWallets,
    holders: userHolders,
  };
}

export async function getWalletUserDetail(userId: string) {
  const summary = await buildWalletUserSummary(userId);
  if (!summary) return null;

  const [transactions, pendingDeposits, pendingWithdrawals, activeEscrows] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
    prisma.deposit.count({ where: { userId, status: "PENDING" } }),
    prisma.withdrawal.count({ where: { userId, status: { in: ["PENDING", "PROCESSING"] } } }),
    prisma.escrow.count({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: { in: ["ACTIVE", "DISPUTED", "AWAITING_FUNDS"] },
      },
    }),
  ]);

  const escrowRows = await prisma.escrowMilestone.findMany({
    where: { status: "FUNDED", escrow: { buyerId: userId } },
    include: {
      escrow: { select: { id: true, title: true, currency: true, status: true } },
    },
    orderBy: { sortOrder: "asc" },
    take: 20,
  });

  return {
    ...summary,
    pendingDeposits,
    pendingWithdrawals,
    activeEscrows,
    escrowMilestones: escrowRows.map((m) => ({
      id: m.id,
      label: m.label,
      amountMinor: m.amountMinor.toString(),
      currency: m.escrow.currency,
      escrowId: m.escrow.id,
      escrowTitle: m.escrow.title,
      escrowStatus: m.escrow.status,
    })),
    transactions: transactions.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      subtitle: t.subtitle,
      currency: t.currency,
      amountDisplay: t.amountDisplay,
      amountPositive: t.amountPositive,
      status: t.status,
      createdAt: t.createdAt,
    })),
  };
}

export async function adjustUserWallet(input: {
  userId: string;
  currency: Currency;
  amountMinor: bigint;
  direction: "credit" | "debit";
  note: string;
  actorId: string;
}) {
  if (input.amountMinor <= 0n) throw new Error("Amount must be positive");

  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({
      where: { userId_currency: { userId: input.userId, currency: input.currency } },
    });
    if (!wallet) throw new Error(`No ${input.currency} wallet for this user`);

    const ref = `admin_adj_${Date.now()}`;
    const description = input.note.trim() || "Admin wallet adjustment";

    if (input.direction === "credit") {
      await creditWallet(tx, input.userId, input.currency, input.amountMinor, description, ref);
    } else {
      await debitWallet(tx, input.userId, input.currency, input.amountMinor, description, ref);
    }

    const signed = input.direction === "credit";
    await recordTx(tx, {
      userId: input.userId,
      kind: "admin_adjustment",
      title: signed ? "Admin credit" : "Admin debit",
      subtitle: description,
      currency: input.currency,
      amountDisplay: `${signed ? "+" : "−"}${formatMoney(input.currency, input.amountMinor)}`,
      amountPositive: signed,
      status: "COMPLETED",
      icon: "activity",
    });

    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: `wallet.${input.direction}`,
        entity: "wallet",
        entityId: wallet.id,
        meta: {
          userId: input.userId,
          currency: input.currency,
          amountMinor: input.amountMinor.toString(),
          note: input.note,
        },
      },
    });

    const updated = await tx.wallet.findUnique({ where: { id: wallet.id } });
    return updated;
  });
}

export async function setWalletUserFrozen(input: {
  userId: string;
  frozen: boolean;
  note?: string;
  actorId: string;
}) {
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new Error("User not found");

  await prisma.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.frozen ? "user.suspend" : "user.unsuspend",
      entity: "user",
      entityId: input.userId,
      meta: input.note ? { note: input.note, via: "wallet_admin" } : { via: "wallet_admin" },
    },
  });

  return resolveWalletAccessStatus(input.userId);
}
