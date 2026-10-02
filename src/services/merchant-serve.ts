import { randomInt } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { creditWallet } from "./ledger.js";
import { quotePlatformAndAgent } from "./merchant-fees.js";
import { stubNameCheck } from "./merchant-name-check.js";
import {
  applyCashIn,
  applyCashOut,
  creditEarnings,
  getFloat,
} from "./merchant-float.js";

function nextRef(prefix: string) {
  return `${prefix}${randomInt(10000, 99999)}`;
}

function normalizePhone(phone: string) {
  return phone.replace(/\s+/g, "").trim();
}

export async function quoteFees(
  service: "CASH_OUT" | "CASH_IN" | "BILL" | "TRANSFER",
  amountMinor: bigint | number,
  agentFeeOverride?: bigint | number | null,
) {
  return quotePlatformAndAgent(service, amountMinor, agentFeeOverride);
}

export async function startCashOut(opts: {
  merchantId: string;
  amountMinor: bigint;
  agentFeeMinor?: bigint | null;
  counterparty?: string | null;
  counterpartyName?: string | null;
}) {
  if (opts.amountMinor <= 0n) throw new Error("Amount required");
  const fees = await quoteFees("CASH_OUT", opts.amountMinor, opts.agentFeeMinor);
  const float = await getFloat(opts.merchantId);
  if (float.cashMinor < opts.amountMinor) {
    throw new Error("Insufficient cash float for this withdrawal");
  }

  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: opts.merchantId } });
  const ref = nextRef("WD-");

  const row = await prisma.merchantTransaction.create({
    data: {
      ref,
      merchantId: opts.merchantId,
      kind: "CASH_OUT",
      amountMinor: -opts.amountMinor,
      platformFeeMinor: fees.platformFeeMinor,
      agentFeeMinor: fees.agentFeeMinor,
      customerTotalMinor: fees.customerTotalMinor,
      counterparty: opts.counterparty ?? null,
      counterpartyName: opts.counterpartyName ?? null,
      status: "PENDING",
      meta: {
        vaBank: merchant.vaBank,
        vaAccountNumber: merchant.vaAccountNumber,
        agentId: merchant.agentId,
        tag: merchant.tag,
      },
    },
  });

  return row;
}

export async function confirmCashOut(merchantId: string, ref: string) {
  const row = await prisma.merchantTransaction.findFirst({
    where: { ref, merchantId, kind: "CASH_OUT" },
  });
  if (!row) throw new Error("Transaction not found");
  if (row.status !== "PENDING") throw new Error(`Cannot confirm status ${row.status}`);

  const amount = row.amountMinor < 0n ? -row.amountMinor : row.amountMinor;

  return prisma.$transaction(async (db) => {
    await applyCashOut(merchantId, amount, db);
    // Customer paid amount+fees into digital float (stub: credit digital by customer total)
    await db.merchantFloat.update({
      where: { merchantId },
      data: { digitalMinor: { increment: row.customerTotalMinor } },
    });
    await creditEarnings(merchantId, row.agentFeeMinor, db);
    return db.merchantTransaction.update({
      where: { id: row.id },
      data: { status: "COMPLETED" },
    });
  });
}

export async function cancelCashOut(merchantId: string, ref: string) {
  const row = await prisma.merchantTransaction.findFirst({
    where: { ref, merchantId, kind: "CASH_OUT" },
  });
  if (!row) throw new Error("Transaction not found");
  if (row.status !== "PENDING") throw new Error(`Cannot cancel status ${row.status}`);
  return prisma.merchantTransaction.update({
    where: { id: row.id },
    data: { status: "FAILED", meta: { ...(row.meta as object), cancelled: true } },
  });
}

export async function cashIn(opts: {
  merchantId: string;
  amountMinor: bigint;
  agentFeeMinor?: bigint | null;
  phone?: string | null;
  walletTag?: string | null;
  counterpartyName?: string | null;
  bankAccount?: string | null;
  bankName?: string | null;
}) {
  if (opts.amountMinor <= 0n) throw new Error("Amount required");
  const fees = await quoteFees("CASH_IN", opts.amountMinor, opts.agentFeeMinor);
  const float = await getFloat(opts.merchantId);
  if (float.digitalMinor < opts.amountMinor) {
    throw new Error("Insufficient digital float to fund wallet");
  }

  const phone = opts.phone ? normalizePhone(opts.phone) : null;
  let targetUser =
    phone != null
      ? await prisma.user.findUnique({ where: { phone } })
      : null;

  if (!targetUser && opts.walletTag) {
    const tag = opts.walletTag.startsWith("@") ? opts.walletTag : `@${opts.walletTag}`;
    const m = await prisma.merchant.findUnique({ where: { tag } });
    if (m) {
      targetUser = await prisma.user.findUnique({ where: { id: m.userId } });
    }
  }

  const nameCheck = stubNameCheck(
    phone || opts.walletTag ? "wallet" : "account",
    phone ?? opts.walletTag ?? opts.bankAccount ?? "",
  );
  if (!nameCheck.ok) throw new Error(nameCheck.message);

  const ref = nextRef("DP-");

  return prisma.$transaction(async (db) => {
    await applyCashIn(opts.merchantId, fees.customerTotalMinor, opts.amountMinor, db);

    if (targetUser) {
      const wallet = await db.wallet.findUnique({
        where: { userId_currency: { userId: targetUser.id, currency: "NGN" } },
      });
      if (!wallet) {
        await db.wallet.create({
          data: { userId: targetUser.id, currency: "NGN", balanceMinor: 0n },
        });
      }
      await creditWallet(
        db,
        targetUser.id,
        "NGN",
        opts.amountMinor,
        `Merchant cash-in ${ref}`,
        ref,
      );
    }

    await creditEarnings(opts.merchantId, fees.agentFeeMinor, db);

    return db.merchantTransaction.create({
      data: {
        ref,
        merchantId: opts.merchantId,
        kind: "CASH_IN",
        amountMinor: opts.amountMinor,
        platformFeeMinor: fees.platformFeeMinor,
        agentFeeMinor: fees.agentFeeMinor,
        customerTotalMinor: fees.customerTotalMinor,
        counterparty: phone ?? opts.walletTag ?? opts.bankAccount ?? null,
        counterpartyName: opts.counterpartyName ?? nameCheck.name,
        status: "COMPLETED",
        meta: {
          bankName: opts.bankName ?? null,
          creditedUserId: targetUser?.id ?? null,
          nameCheck: nameCheck.name,
        },
      },
    });
  });
}

export async function transfer(opts: {
  merchantId: string;
  amountMinor: bigint;
  agentFeeMinor?: bigint | null;
  destination: string;
  counterpartyName?: string | null;
}) {
  if (opts.amountMinor <= 0n) throw new Error("Amount required");
  const fees = await quoteFees("TRANSFER", opts.amountMinor, opts.agentFeeMinor);
  const float = await getFloat(opts.merchantId);
  const debit = fees.customerTotalMinor;
  if (float.digitalMinor < debit) {
    throw new Error("Insufficient digital float");
  }

  const nameCheck = stubNameCheck("wallet", opts.destination);
  if (!nameCheck.ok) throw new Error(nameCheck.message);

  const ref = nextRef("TR-");

  return prisma.$transaction(async (db) => {
    await db.merchantFloat.update({
      where: { merchantId: opts.merchantId },
      data: { digitalMinor: { decrement: debit } },
    });
    await creditEarnings(opts.merchantId, fees.agentFeeMinor, db);
    return db.merchantTransaction.create({
      data: {
        ref,
        merchantId: opts.merchantId,
        kind: "TRANSFER",
        amountMinor: -opts.amountMinor,
        platformFeeMinor: fees.platformFeeMinor,
        agentFeeMinor: fees.agentFeeMinor,
        customerTotalMinor: fees.customerTotalMinor,
        counterparty: opts.destination,
        counterpartyName: opts.counterpartyName ?? nameCheck.name,
        status: "COMPLETED",
      },
    });
  });
}

/** Guest display: virtual account details for customers without the app. */
export async function guestDisplayVa(merchantId: string) {
  const m = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
  return {
    agentId: m.agentId,
    tag: m.tag,
    businessName: m.businessName,
    vaBank: m.vaBank,
    vaAccountNumber: m.vaAccountNumber,
    phone: m.phone,
  };
}
