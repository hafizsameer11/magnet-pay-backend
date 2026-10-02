import { randomInt } from "node:crypto";
import type { BillerCategory } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { quotePlatformAndAgent } from "./merchant-fees.js";
import { stubNameCheck } from "./merchant-name-check.js";
import { creditEarnings, getFloat } from "./merchant-float.js";

function nextRef(prefix: string) {
  return `${prefix}${randomInt(10000, 99999)}`;
}

function powerToken() {
  const parts = Array.from({ length: 5 }, () => String(randomInt(1000, 9999)));
  return parts.join("-");
}

export async function listBillers(category?: BillerCategory | string) {
  const where = {
    enabled: true,
    ...(category ? { category: category as BillerCategory } : {}),
  };
  return prisma.biller.findMany({
    where,
    include: { plans: { orderBy: { sort: "asc" } } },
    orderBy: [{ category: "asc" }, { sort: "asc" }],
  });
}

export async function verifyBill(opts: {
  billerId: string;
  account: string;
  prepaid?: boolean;
}) {
  const biller = await prisma.biller.findUnique({ where: { id: opts.billerId } });
  if (!biller || !biller.enabled) {
    return { ok: false as const, message: "Biller not found" };
  }

  let kind: string = "wallet";
  if (biller.category === "AIRTIME" || biller.category === "DATA") kind = "phone";
  else if (biller.category === "POWER") kind = "meter";
  else if (biller.category === "CABLE") kind = "smartcard";

  const check = stubNameCheck(kind, opts.account);
  if (!check.ok) return { ok: false as const, message: check.message, biller };

  return {
    ok: true as const,
    biller,
    account: opts.account,
    name: check.name,
    prepaid: opts.prepaid ?? biller.category === "POWER",
  };
}

export async function payBill(opts: {
  merchantId: string;
  billerId: string;
  account: string;
  amountMinor: bigint;
  agentFeeMinor?: bigint | null;
  planId?: string | null;
  prepaid?: boolean;
  counterpartyName?: string | null;
}) {
  const biller = await prisma.biller.findUnique({
    where: { id: opts.billerId },
    include: { plans: true },
  });
  if (!biller || !biller.enabled) throw new Error("Biller not found");

  let amount = opts.amountMinor;
  if (opts.planId) {
    const plan = biller.plans.find((p) => p.id === opts.planId);
    if (!plan) throw new Error("Plan not found");
    amount = BigInt(plan.priceMinor);
  }
  if (amount <= 0n) throw new Error("Amount required");

  const fees = await quotePlatformAndAgent("BILL", amount, opts.agentFeeMinor);
  const float = await getFloat(opts.merchantId);
  const debit = fees.customerTotalMinor;
  if (float.digitalMinor < debit) {
    throw new Error("Insufficient digital float");
  }

  const verified = await verifyBill({
    billerId: opts.billerId,
    account: opts.account,
    prepaid: opts.prepaid,
  });
  if (!verified.ok) throw new Error(verified.message);

  const token =
    biller.category === "POWER" && (opts.prepaid ?? true) ? powerToken() : null;
  const ref = nextRef("BL-");

  const tx = await prisma.$transaction(async (db) => {
    await db.merchantFloat.update({
      where: { merchantId: opts.merchantId },
      data: { digitalMinor: { decrement: debit } },
    });

    const row = await db.merchantTransaction.create({
      data: {
        ref,
        merchantId: opts.merchantId,
        kind: "BILL",
        amountMinor: -amount,
        platformFeeMinor: fees.platformFeeMinor,
        agentFeeMinor: fees.agentFeeMinor,
        customerTotalMinor: fees.customerTotalMinor,
        counterparty: opts.account,
        counterpartyName: opts.counterpartyName ?? verified.name,
        billerId: biller.id,
        billAccount: opts.account,
        token,
        status: "COMPLETED",
        meta: {
          category: biller.category,
          billerName: biller.name,
          planId: opts.planId ?? null,
        },
      },
    });

    await creditEarnings(opts.merchantId, fees.agentFeeMinor, db);
    return row;
  });

  return tx;
}
