import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/** Warn when cash on hand is at or below this (₦50,000). */
export const LOW_CASH_THRESHOLD_MINOR = 5_000_000n;

export async function getFloat(merchantId: string) {
  let row = await prisma.merchantFloat.findUnique({ where: { merchantId } });
  if (!row) {
    row = await prisma.merchantFloat.create({
      data: { merchantId, cashMinor: 0n, digitalMinor: 0n },
    });
  }
  const total = row.cashMinor + row.digitalMinor;
  return {
    ...row,
    totalMinor: total,
    lowCash: row.cashMinor <= LOW_CASH_THRESHOLD_MINOR,
  };
}

export async function topUpDigital(
  merchantId: string,
  amountMinor: bigint,
  tx?: Prisma.TransactionClient,
) {
  if (amountMinor <= 0n) throw new Error("Top-up amount must be positive");
  const db = tx ?? prisma;
  const existing = await db.merchantFloat.findUnique({ where: { merchantId } });
  if (!existing) {
    return db.merchantFloat.create({
      data: { merchantId, cashMinor: 0n, digitalMinor: amountMinor },
    });
  }
  return db.merchantFloat.update({
    where: { merchantId },
    data: { digitalMinor: existing.digitalMinor + amountMinor },
  });
}

/** Cash out: hand physical cash to customer → cash float decreases. */
export async function applyCashOut(
  merchantId: string,
  amountMinor: bigint,
  tx?: Prisma.TransactionClient,
) {
  if (amountMinor <= 0n) throw new Error("Amount must be positive");
  const db = tx ?? prisma;
  const f = await ensureFloat(db, merchantId);
  if (f.cashMinor < amountMinor) {
    throw new Error("Insufficient cash float");
  }
  return db.merchantFloat.update({
    where: { merchantId },
    data: { cashMinor: f.cashMinor - amountMinor },
  });
}

/**
 * Cash in: take physical cash → cash += amt.
 * If digital float is used to fund a wallet payout, pass digitalDebit to reduce digital.
 */
export async function applyCashIn(
  merchantId: string,
  amountMinor: bigint,
  digitalDebit: bigint = 0n,
  tx?: Prisma.TransactionClient,
) {
  if (amountMinor <= 0n) throw new Error("Amount must be positive");
  const db = tx ?? prisma;
  const f = await ensureFloat(db, merchantId);
  if (digitalDebit > 0n && f.digitalMinor < digitalDebit) {
    throw new Error("Insufficient digital float");
  }
  return db.merchantFloat.update({
    where: { merchantId },
    data: {
      cashMinor: f.cashMinor + amountMinor,
      digitalMinor: digitalDebit > 0n ? f.digitalMinor - digitalDebit : f.digitalMinor,
    },
  });
}

export async function creditEarnings(
  merchantId: string,
  amountMinor: bigint,
  tx?: Prisma.TransactionClient,
) {
  if (amountMinor <= 0n) return;
  const db = tx ?? prisma;
  await db.merchant.update({
    where: { id: merchantId },
    data: { unpaidEarningsMinor: { increment: amountMinor } },
  });
}

export function lowCash(cashMinor: bigint): boolean {
  return cashMinor <= LOW_CASH_THRESHOLD_MINOR;
}

async function ensureFloat(db: Prisma.TransactionClient | typeof prisma, merchantId: string) {
  let f = await db.merchantFloat.findUnique({ where: { merchantId } });
  if (!f) {
    f = await db.merchantFloat.create({
      data: { merchantId, cashMinor: 0n, digitalMinor: 0n },
    });
  }
  return f;
}
