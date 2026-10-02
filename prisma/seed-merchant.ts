import type { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

type SeedAsset = (file: string) => string;

/** Seed billers, fee/tier rules, and demo merchant MP-AG-4471. */
export async function seedMerchantModule(prisma: PrismaClient, seedAsset: SeedAsset) {
  const billers = [
    { category: "AIRTIME" as const, name: "MTN", logo: "biller-mtn.png", brandColor: "#FFCC00", sort: 1 },
    { category: "AIRTIME" as const, name: "Airtel", logo: "biller-airtel.png", brandColor: "#E30613", sort: 2 },
    { category: "AIRTIME" as const, name: "Glo", logo: "biller-glo.png", brandColor: "#00A651", sort: 3 },
    { category: "AIRTIME" as const, name: "9mobile", logo: "biller-9mobile.png", brandColor: "#00694B", sort: 4 },
    { category: "DATA" as const, name: "MTN", logo: "biller-mtn.png", brandColor: "#FFCC00", sort: 1 },
    { category: "DATA" as const, name: "Airtel", logo: "biller-airtel.png", brandColor: "#E30613", sort: 2 },
    { category: "DATA" as const, name: "Glo", logo: "biller-glo.png", brandColor: "#00A651", sort: 3 },
    { category: "DATA" as const, name: "9mobile", logo: "biller-9mobile.png", brandColor: "#00694B", sort: 4 },
    { category: "POWER" as const, name: "Ikeja Electric", logo: "biller-ikeja.png", brandColor: "#F5A800", sort: 1 },
    { category: "POWER" as const, name: "Eko Disco", logo: "biller-eko.png", brandColor: "#003087", sort: 2 },
    { category: "POWER" as const, name: "Abuja Electric", logo: "biller-abuja.png", brandColor: "#1B4D3E", sort: 3 },
    { category: "POWER" as const, name: "Ibadan Disco", logo: "biller-ibadan.png", brandColor: "#C2410C", sort: 4 },
    { category: "POWER" as const, name: "PH Disco", logo: "biller-phed.png", brandColor: "#0E3B2E", sort: 5 },
    { category: "POWER" as const, name: "Kano Disco", logo: "biller-kano.png", brandColor: "#1E40AF", sort: 6 },
    { category: "CABLE" as const, name: "DStv", logo: "biller-dstv.png", brandColor: "#005FAA", sort: 1 },
    { category: "CABLE" as const, name: "GOtv", logo: "biller-gotv.png", brandColor: "#E21B24", sort: 2 },
    { category: "CABLE" as const, name: "Startimes", logo: "biller-startimes.png", brandColor: "#E84C22", sort: 3 },
  ];

  const dataPlans = [
    { name: "1GB · 30 days", priceMinor: 50000 },
    { name: "2GB · 30 days", priceMinor: 100000 },
    { name: "5GB · 30 days", priceMinor: 200000 },
    { name: "10GB · 30 days", priceMinor: 350000 },
    { name: "20GB · 30 days", priceMinor: 750000 },
  ];

  const cablePackages = [
    { name: "Padi", priceMinor: 190000 },
    { name: "Yanga", priceMinor: 295000 },
    { name: "Compact", priceMinor: 900000 },
    { name: "Compact Plus", priceMinor: 1425000 },
    { name: "Premium", priceMinor: 1900000 },
  ];

  for (const b of billers) {
    const row = await prisma.biller.upsert({
      where: { category_name: { category: b.category, name: b.name } },
      create: {
        category: b.category,
        name: b.name,
        logoUrl: seedAsset(b.logo),
        brandColor: b.brandColor,
        enabled: true,
        sort: b.sort,
      },
      update: {
        logoUrl: seedAsset(b.logo),
        brandColor: b.brandColor,
        enabled: true,
        sort: b.sort,
      },
    });

    if (b.category === "DATA") {
      await prisma.billerPlan.deleteMany({ where: { billerId: row.id } });
      await prisma.billerPlan.createMany({
        data: dataPlans.map((p, i) => ({
          billerId: row.id,
          name: p.name,
          priceMinor: p.priceMinor,
          sort: i,
        })),
      });
    }
    if (b.category === "CABLE") {
      await prisma.billerPlan.deleteMany({ where: { billerId: row.id } });
      await prisma.billerPlan.createMany({
        data: cablePackages.map((p, i) => ({
          billerId: row.id,
          name: p.name,
          priceMinor: p.priceMinor,
          sort: i,
        })),
      });
    }
  }

  await prisma.merchantFeeRule.deleteMany();
  await prisma.merchantFeeRule.createMany({
    data: [
      { service: "CASH_OUT", minAmount: 0, maxAmount: 2000000, feeType: "percent", value: 50, version: 1 }, // 0.5% in bps? value=50 means 0.5% as tenths - use value as percent*100: 50 = 0.5%
      { service: "CASH_OUT", minAmount: 2000001, maxAmount: null, feeType: "flat", value: 10000, version: 1 }, // ₦100
      { service: "CASH_IN", minAmount: 0, maxAmount: 499999, feeType: "flat", value: 1000, version: 1 },
      { service: "CASH_IN", minAmount: 500000, maxAmount: 1000000, feeType: "flat", value: 2000, version: 1 },
      { service: "CASH_IN", minAmount: 1000001, maxAmount: null, feeType: "flat", value: 5000, version: 1 },
      { service: "BILL", minAmount: 0, maxAmount: 499999, feeType: "flat", value: 1000, version: 1 },
      { service: "BILL", minAmount: 500000, maxAmount: 1000000, feeType: "flat", value: 2000, version: 1 },
      { service: "BILL", minAmount: 1000001, maxAmount: null, feeType: "flat", value: 5000, version: 1 },
      { service: "TRANSFER", minAmount: 0, maxAmount: 499999, feeType: "flat", value: 1000, version: 1 },
      { service: "TRANSFER", minAmount: 500000, maxAmount: 1000000, feeType: "flat", value: 2000, version: 1 },
      { service: "TRANSFER", minAmount: 1000001, maxAmount: null, feeType: "flat", value: 5000, version: 1 },
    ],
  });

  await prisma.merchantTierRule.deleteMany();
  await prisma.merchantTierRule.createMany({
    data: [
      {
        tier: "SILVER",
        monthlyVolumeThreshold: 0n,
        dailyLimitMinor: 50000000,
        singleLimitMinor: 20000000,
      },
      {
        tier: "GOLD",
        monthlyVolumeThreshold: 842000000n, // ₦8.42M
        dailyLimitMinor: 200000000,
        singleLimitMinor: 50000000,
      },
      {
        tier: "PLATINUM",
        monthlyVolumeThreshold: 5000000000n,
        dailyLimitMinor: 500000000,
        singleLimitMinor: 100000000,
      },
    ],
  });

  const passcodeHash = await bcrypt.hash("123456", 10);
  const merchantUser = await prisma.user.create({
    data: {
      phone: "+2348031112233",
      email: "ikeja.union@magnetpay.test",
      name: "Ikeja Union Ventures",
      role: "MERCHANT",
      platformRole: "USER",
      passcodeHash,
      onboardingDone: true,
      locale: "en",
    },
  });

  const merchant = await prisma.merchant.create({
    data: {
      userId: merchantUser.id,
      agentId: "MP-AG-4471",
      tag: "@ikeja.union",
      businessName: "Ikeja Union Ventures",
      businessType: "REGISTERED",
      category: "Retail / Agent banking",
      address: "12 Allen Ave, Ikeja, Lagos",
      state: "Lagos",
      lga: "Ikeja",
      lat: 6.6018,
      lng: 3.3515,
      phone: "+2348031112233",
      ownerName: "Ikeja Union",
      bvnLast4: "4471",
      bvnVerified: true,
      ninVerified: true,
      status: "ACTIVE",
      tier: "SILVER",
      dailyLimit: 50000000,
      premiumPartner: true,
      listedInDirectory: true,
      settlementBank: "GTBank",
      settlementAccount: "0123456789",
      settlementAccountName: "Ikeja Union Ventures",
      vaBank: "Wema Bank",
      vaAccountNumber: "7829944710",
      passcodeHash,
      unpaidEarningsMinor: 1842000n,
      openHours: { open: "07:00", close: "21:00", days: [1, 2, 3, 4, 5, 6] },
      float: {
        create: {
          cashMinor: 31000000n,
          digitalMinor: 53260000n,
        },
      },
      documents: {
        create: [
          { kind: "CAC", fileUrl: seedAsset("bags.jpg"), status: "APPROVED" },
          { kind: "GOV_ID", fileUrl: seedAsset("bags.jpg"), status: "APPROVED" },
          { kind: "SHOP_PHOTO", fileUrl: seedAsset("shipping.jpg"), status: "APPROVED" },
          { kind: "UTILITY", fileUrl: seedAsset("electronics.jpg"), status: "APPROVED" },
        ],
      },
      branches: {
        create: [
          { name: "Allen Ave HQ", address: "12 Allen Ave, Ikeja", cashMinor: 20000000n, digitalMinor: 40000000n },
          { name: "Computer Village", address: "Ikeja Computer Village", cashMinor: 11000000n, digitalMinor: 13260000n },
        ],
      },
      staff: {
        create: [
          { name: "Tunde Cashier", phone: "+2348011110001", role: "cashier", permissions: { cashIn: true, cashOut: true, bills: true } },
          { name: "Ada Supervisor", phone: "+2348011110002", role: "supervisor", permissions: { cashIn: true, cashOut: true, bills: true, settle: true } },
        ],
      },
    },
  });

  const txs = [
    { kind: "CASH_OUT" as const, ref: "WD-88213", amountMinor: -5100000n, fee: 25500n, name: "Adaeze O.", status: "COMPLETED" as const },
    { kind: "CASH_IN" as const, ref: "DP-88196", amountMinor: 2000000n, fee: 5000n, name: "Emeka N.", status: "COMPLETED" as const },
    { kind: "CASH_OUT" as const, ref: "WD-88152", amountMinor: -1500000n, fee: 7500n, name: "Chidi A.", status: "PENDING" as const },
    { kind: "BILL" as const, ref: "BL-88140", amountMinor: -735000n, fee: 3500n, name: "Eko Electricity", status: "COMPLETED" as const },
    { kind: "CASH_IN" as const, ref: "DP-88131", amountMinor: 4500000n, fee: 18000n, name: "Tunde B.", status: "COMPLETED" as const },
    { kind: "TRANSFER" as const, ref: "TR-88120", amountMinor: -3000000n, fee: 0n, name: "Mama Ngozi", status: "COMPLETED" as const },
    { kind: "CASH_IN" as const, ref: "DP-88109", amountMinor: 1200000n, fee: 4800n, name: "Femi K.", status: "COMPLETED" as const },
    { kind: "CASH_OUT" as const, ref: "WD-88095", amountMinor: -9000000n, fee: 50000n, name: "Amaka I.", status: "COMPLETED" as const },
  ];

  const now = Date.now();
  for (let i = 0; i < txs.length; i++) {
    const t = txs[i]!;
    const amt = t.amountMinor < 0n ? -t.amountMinor : t.amountMinor;
    await prisma.merchantTransaction.create({
      data: {
        ref: t.ref,
        merchantId: merchant.id,
        kind: t.kind,
        amountMinor: t.amountMinor,
        platformFeeMinor: t.fee,
        agentFeeMinor: t.fee,
        customerTotalMinor: amt + t.fee + t.fee,
        counterparty: t.name,
        counterpartyName: t.name,
        status: t.status,
        createdAt: new Date(now - i * 25 * 60 * 1000),
      },
    });
  }

  await prisma.merchantSettlement.create({
    data: {
      merchantId: merchant.id,
      amountMinor: 1842000n,
      bank: "GTBank",
      accountLast4: "6789",
      batchDate: new Date(),
      status: "QUEUED",
    },
  });

  return { merchantUser, merchant };
}
