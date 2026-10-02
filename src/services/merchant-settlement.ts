import { prisma } from "../lib/prisma.js";

export async function settleNow(merchantId: string) {
  const merchant = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
  if (merchant.unpaidEarningsMinor <= 0n) {
    throw new Error("No unpaid earnings to settle");
  }
  if (!merchant.settlementBank || !merchant.settlementAccount) {
    throw new Error("Settlement bank not configured");
  }

  const pendingChange = await prisma.settlementBankChange.findFirst({
    where: {
      merchantId,
      status: "PENDING",
      pauseUntil: { gt: new Date() },
    },
  });
  if (pendingChange) {
    throw new Error("Payouts paused for 24h after settlement bank change");
  }

  const amount = merchant.unpaidEarningsMinor;
  const accountLast4 = merchant.settlementAccount.slice(-4);

  const settlement = await prisma.$transaction(async (db) => {
    await db.merchant.update({
      where: { id: merchantId },
      data: { unpaidEarningsMinor: 0n },
    });
    const queued = await db.merchantSettlement.create({
      data: {
        merchantId,
        amountMinor: amount,
        bank: merchant.settlementBank!,
        accountLast4,
        batchDate: new Date(),
        status: "QUEUED",
      },
    });
    // Stub payout: mark paid immediately
    return db.merchantSettlement.update({
      where: { id: queued.id },
      data: { status: "PAID" },
    });
  });

  return settlement;
}

export async function listSettlements(merchantId: string, take = 50) {
  return prisma.merchantSettlement.findMany({
    where: { merchantId },
    orderBy: { createdAt: "desc" },
    take,
  });
}
