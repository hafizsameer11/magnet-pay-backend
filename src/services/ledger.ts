import type { Currency, LedgerAccountType, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export async function ensureUserLedgerAccounts(tx: Prisma.TransactionClient, userId: string, currency: Currency) {
  const types: LedgerAccountType[] = ["USER_WALLET", "ESCROW_HOLD", "LOGISTICS_HOLD"];
  for (const type of types) {
    const existing = await tx.ledgerAccount.findFirst({ where: { userId, type, currency } });
    if (!existing) {
      await tx.ledgerAccount.create({
        data: { userId, type, currency, name: `${type}:${currency}:${userId.slice(0, 8)}` },
      });
    }
  }
}

export async function ensureSystemAccounts(tx: Prisma.TransactionClient, currency: Currency) {
  for (const type of ["SYSTEM_CLEARING", "FEE_REVENUE", "NOMBA_PAYABLE"] as LedgerAccountType[]) {
    const existing = await tx.ledgerAccount.findFirst({ where: { userId: null, type, currency } });
    if (!existing) {
      await tx.ledgerAccount.create({
        data: { userId: null, type, currency, name: `${type}:${currency}` },
      });
    }
  }
}

async function getAccount(
  tx: Prisma.TransactionClient,
  opts: { userId?: string | null; type: LedgerAccountType; currency: Currency },
) {
  const acc = await tx.ledgerAccount.findFirst({
    where: { userId: opts.userId ?? null, type: opts.type, currency: opts.currency },
  });
  if (!acc) throw new Error(`Ledger account missing ${opts.type} ${opts.currency}`);
  return acc;
}

type LineInput = {
  userId?: string | null;
  type: LedgerAccountType;
  currency: Currency;
  debit?: bigint;
  credit?: bigint;
};

export async function postLedger(
  tx: Prisma.TransactionClient,
  description: string,
  lines: LineInput[],
  reference?: string,
) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit ?? 0n), 0n);
  const totalCredit = lines.reduce((s, l) => s + (l.credit ?? 0n), 0n);
  if (totalDebit !== totalCredit) {
    throw new Error(`Unbalanced ledger entry: debit ${totalDebit} credit ${totalCredit}`);
  }

  const entry = await tx.ledgerEntry.create({
    data: {
      description,
      reference,
      lines: {
        create: await Promise.all(
          lines.map(async (l) => {
            const account = await getAccount(tx, {
              userId: l.userId ?? null,
              type: l.type,
              currency: l.currency,
            });
            return {
              accountId: account.id,
              debit: l.debit ?? 0n,
              credit: l.credit ?? 0n,
            };
          }),
        ),
      },
    },
  });
  return entry;
}

export async function creditWallet(
  tx: Prisma.TransactionClient,
  userId: string,
  currency: Currency,
  amountMinor: bigint,
  description: string,
  reference?: string,
) {
  await ensureSystemAccounts(tx, currency);
  await ensureUserLedgerAccounts(tx, userId, currency);
  const wallet = await tx.wallet.findUnique({ where: { userId_currency: { userId, currency } } });
  if (!wallet) throw new Error("Wallet not found");
  await tx.wallet.update({
    where: { id: wallet.id },
    data: { balanceMinor: wallet.balanceMinor + amountMinor },
  });
  await postLedger(
    tx,
    description,
    [
      { userId: null, type: "SYSTEM_CLEARING", currency, debit: amountMinor },
      { userId, type: "USER_WALLET", currency, credit: amountMinor },
    ],
    reference,
  );
}

export async function debitWallet(
  tx: Prisma.TransactionClient,
  userId: string,
  currency: Currency,
  amountMinor: bigint,
  description: string,
  reference?: string,
  counterparty: LedgerAccountType = "SYSTEM_CLEARING",
) {
  await ensureSystemAccounts(tx, currency);
  await ensureUserLedgerAccounts(tx, userId, currency);
  const wallet = await tx.wallet.findUnique({ where: { userId_currency: { userId, currency } } });
  if (!wallet) throw new Error("Wallet not found");
  const available = wallet.balanceMinor - wallet.holdMinor;
  if (available < amountMinor) {
    throw new Error(
      `Insufficient balance · available ${formatMoney(currency, available)} · need ${formatMoney(currency, amountMinor)}`,
    );
  }
  await tx.wallet.update({
    where: { id: wallet.id },
    data: { balanceMinor: wallet.balanceMinor - amountMinor },
  });
  await postLedger(
    tx,
    description,
    [
      { userId, type: "USER_WALLET", currency, debit: amountMinor },
      { userId: null, type: counterparty, currency, credit: amountMinor },
    ],
    reference,
  );
}

export async function lockToHold(
  tx: Prisma.TransactionClient,
  userId: string,
  currency: Currency,
  amountMinor: bigint,
  holdType: "ESCROW_HOLD" | "LOGISTICS_HOLD",
  description: string,
  reference?: string,
) {
  await ensureUserLedgerAccounts(tx, userId, currency);
  const wallet = await tx.wallet.findUnique({ where: { userId_currency: { userId, currency } } });
  if (!wallet) throw new Error("Wallet not found");
  const available = wallet.balanceMinor - wallet.holdMinor;
  if (available < amountMinor) throw new Error("Insufficient available balance");
  await tx.wallet.update({
    where: { id: wallet.id },
    data: { holdMinor: wallet.holdMinor + amountMinor },
  });
  await postLedger(
    tx,
    description,
    [
      { userId, type: "USER_WALLET", currency, debit: amountMinor },
      { userId, type: holdType, currency, credit: amountMinor },
    ],
    reference,
  );
}

/**
 * Pays a seller from buyer escrow.
 * Normal path: funds sit on the buyer wallet as `holdMinor` (fund / checkout lock).
 * Legacy path: older checkouts debited the wallet with no hold — credit the seller
 * from system clearing so the buyer is not charged twice.
 */
export async function settleEscrowRelease(
  tx: Prisma.TransactionClient,
  fromUserId: string,
  toUserId: string,
  currency: Currency,
  amountMinor: bigint,
  description: string,
  reference?: string,
) {
  const fromWallet = await tx.wallet.findUnique({
    where: { userId_currency: { userId: fromUserId, currency } },
  });
  if (fromWallet && fromWallet.holdMinor >= amountMinor) {
    await releaseHoldToWallet(
      tx,
      fromUserId,
      toUserId,
      currency,
      amountMinor,
      "ESCROW_HOLD",
      description,
      reference,
    );
    return;
  }
  await creditWallet(tx, toUserId, currency, amountMinor, description, reference);
}

export async function releaseHoldToWallet(
  tx: Prisma.TransactionClient,
  fromUserId: string,
  toUserId: string,
  currency: Currency,
  amountMinor: bigint,
  holdType: "ESCROW_HOLD" | "LOGISTICS_HOLD",
  description: string,
  reference?: string,
) {
  await ensureUserLedgerAccounts(tx, fromUserId, currency);
  await ensureUserLedgerAccounts(tx, toUserId, currency);
  const fromWallet = await tx.wallet.findUnique({
    where: { userId_currency: { userId: fromUserId, currency } },
  });
  if (!fromWallet || fromWallet.holdMinor < amountMinor) throw new Error("Insufficient hold");
  await tx.wallet.update({
    where: { id: fromWallet.id },
    data: {
      holdMinor: fromWallet.holdMinor - amountMinor,
      balanceMinor: fromWallet.balanceMinor - amountMinor,
    },
  });
  const toWallet = await tx.wallet.findUnique({
    where: { userId_currency: { userId: toUserId, currency } },
  });
  if (!toWallet) throw new Error("Counterparty wallet missing");
  await tx.wallet.update({
    where: { id: toWallet.id },
    data: { balanceMinor: toWallet.balanceMinor + amountMinor },
  });
  await postLedger(
    tx,
    description,
    [
      { userId: fromUserId, type: holdType, currency, debit: amountMinor },
      { userId: toUserId, type: "USER_WALLET", currency, credit: amountMinor },
    ],
    reference,
  );
}

export async function unlockHoldCashback(
  tx: Prisma.TransactionClient,
  userId: string,
  currency: Currency,
  unlockMinor: bigint,
  holdType: "ESCROW_HOLD" | "LOGISTICS_HOLD",
  description: string,
) {
  await ensureUserLedgerAccounts(tx, userId, currency);
  const wallet = await tx.wallet.findUnique({ where: { userId_currency: { userId, currency } } });
  if (!wallet || wallet.holdMinor < unlockMinor) throw new Error("Insufficient hold");
  await tx.wallet.update({
    where: { id: wallet.id },
    data: { holdMinor: wallet.holdMinor - unlockMinor },
  });
  await postLedger(tx, description, [
    { userId, type: holdType, currency, debit: unlockMinor },
    { userId, type: "USER_WALLET", currency, credit: unlockMinor },
  ]);
}

export async function consumeHold(
  tx: Prisma.TransactionClient,
  userId: string,
  currency: Currency,
  amountMinor: bigint,
  holdType: "ESCROW_HOLD" | "LOGISTICS_HOLD",
  description: string,
) {
  await ensureSystemAccounts(tx, currency);
  await ensureUserLedgerAccounts(tx, userId, currency);
  const wallet = await tx.wallet.findUnique({ where: { userId_currency: { userId, currency } } });
  if (!wallet || wallet.holdMinor < amountMinor || wallet.balanceMinor < amountMinor) {
    throw new Error("Insufficient hold/balance");
  }
  await tx.wallet.update({
    where: { id: wallet.id },
    data: {
      holdMinor: wallet.holdMinor - amountMinor,
      balanceMinor: wallet.balanceMinor - amountMinor,
    },
  });
  await postLedger(tx, description, [
    { userId, type: holdType, currency, debit: amountMinor },
    { userId: null, type: "SYSTEM_CLEARING", currency, credit: amountMinor },
  ]);
}

export function formatMoney(currency: Currency, minor: bigint): string {
  const n = Number(minor) / 100;
  if (currency === "NGN") return `₦${n.toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;
  if (currency === "CNY") return `¥${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

export async function recordTx(
  tx: Prisma.TransactionClient,
  data: {
    userId: string;
    kind: string;
    title: string;
    subtitle?: string;
    currency: Currency;
    amountDisplay: string;
    amountPositive?: boolean | null;
    status?: string | null;
    icon?: string;
    color?: string;
  },
) {
  return tx.transaction.create({
    data: {
      userId: data.userId,
      kind: data.kind,
      title: data.title,
      subtitle: data.subtitle ?? "",
      currency: data.currency,
      amountDisplay: data.amountDisplay,
      amountPositive: data.amountPositive ?? null,
      status: data.status ?? null,
      icon: data.icon ?? "activity",
      color: data.color ?? "#0E3B2E",
    },
  });
}
