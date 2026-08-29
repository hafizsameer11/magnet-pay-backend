import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { ensureSystemAccounts, ensureUserLedgerAccounts } from "../src/services/ledger.js";
import { DEFAULT_COMPLIANCE_LIMITS } from "../src/services/compliance-limits.js";
import { seedAdminRecords } from "../src/services/admin-records-seed.js";

const prisma = new PrismaClient();

const API_PUBLIC = process.env.API_PUBLIC_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:4000";
const seedAsset = (file: string) => `${API_PUBLIC}/files/seed/${file}`;

/** Local seed-media files (commit to Git) — falls back to Unsplash if missing at seed time. */
const IMG = {
  avatarBuyer: seedAsset("avatar-buyer.jpg"),
  avatarSeller: seedAsset("avatar-seller.jpg"),
  avatarAmaka: seedAsset("avatar-amaka.jpg"),
  avatarKwame: seedAsset("avatar-kwame.jpg"),
  avatarSeller2: seedAsset("avatar-seller2.jpg"),
  pump: seedAsset("pump.jpg"),
  pump2: seedAsset("pump2.jpg"),
  pump3: seedAsset("pump3.jpg"),
  pump4: seedAsset("pump4.jpg"),
  textile: seedAsset("textile.jpg"),
  solar: seedAsset("solar.jpg"),
  electronics: seedAsset("electronics.jpg"),
  machinery: seedAsset("machinery.jpg"),
  shipping: seedAsset("shipping.jpg"),
  led: seedAsset("led.jpg"),
  bags: seedAsset("bags.jpg"),
  tiles: seedAsset("tiles.jpg"),
  fittings: seedAsset("fittings.jpg"),
  mailers: seedAsset("mailers.jpg"),
  charger: seedAsset("charger.jpg"),
  beauty: seedAsset("beauty.jpg"),
  boxes: seedAsset("boxes.jpg"),
};

async function main() {
  console.log("Seeding MagnetPay with catalog images…");

  await prisma.providerEvent.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversationParticipant.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.shipmentDocument.deleteMany();
  await prisma.shipmentEvent.deleteMany();
  await prisma.shipmentSettlement.deleteMany();
  await prisma.shipmentHold.deleteMany();
  await prisma.shipment.deleteMany();
  await prisma.shippingQuote.deleteMany();
  await prisma.shippingQuoteRequest.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.escrowDocument.deleteMany();
  await prisma.escrowMilestone.deleteMany();
  await prisma.escrowInvite.deleteMany();
  await prisma.escrow.deleteMany();
  await prisma.review.deleteMany();
  await prisma.wishlistItem.deleteMany();
  await prisma.rfqQuote.deleteMany();
  await prisma.rfq.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.marketOrder.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.cart.deleteMany();
  await prisma.productMedia.deleteMany();
  await prisma.product.deleteMany();
  await prisma.sellerStore.deleteMany();
  await prisma.category.deleteMany();
  await prisma.transferEvent.deleteMany();
  await prisma.transfer.deleteMany();
  await prisma.recipient.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.fxConversion.deleteMany();
  await prisma.withdrawal.deleteMany();
  await prisma.deposit.deleteMany();
  await prisma.ledgerLine.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.ledgerAccount.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.bankAccount.deleteMany();
  await prisma.address.deleteMany();
  await prisma.businessProfile.deleteMany();
  await prisma.kycApplication.deleteMany();
  await prisma.session.deleteMany();
  await prisma.otpChallenge.deleteMany();
  await prisma.user.deleteMany();
  await prisma.fxRate.deleteMany();
  await prisma.feeConfig.deleteMany();
  await prisma.logisticsPartnerRate.deleteMany();
  await prisma.logisticsPartner.deleteMany();
  await prisma.freightPricing.deleteMany();
  await prisma.complianceLimits.deleteMany();
  await prisma.featureFlag.deleteMany();

  const passcodeHash = await bcrypt.hash("123456", 10);

  const buyer = await prisma.user.create({
    data: {
      phone: "+2348123456789",
      email: "chidi@magnetpay.test",
      name: "Chidi Okoro",
      role: "BUYER",
      platformRole: "USER",
      passcodeHash,
      onboardingDone: true,
      avatarUrl: IMG.avatarBuyer,
      locale: "NG",
    },
  });

  const buyer2 = await prisma.user.create({
    data: {
      phone: "+2348035550144",
      email: "amaka@magnetpay.test",
      name: "Amaka Nwosu",
      role: "BUYER",
      passcodeHash,
      onboardingDone: true,
      avatarUrl: IMG.avatarAmaka,
      locale: "NG",
    },
  });

  const buyer3 = await prisma.user.create({
    data: {
      phone: "+233244123456",
      email: "kwame@magnetpay.test",
      name: "Kwame Boateng",
      role: "BUYER",
      passcodeHash,
      onboardingDone: true,
      avatarUrl: IMG.avatarKwame,
      locale: "GH",
    },
  });

  const seller = await prisma.user.create({
    data: {
      phone: "+8613800138000",
      email: "ops@gz-huayi.test",
      name: "Wei Chen",
      role: "SELLER",
      passcodeHash,
      onboardingDone: true,
      avatarUrl: IMG.avatarSeller,
      locale: "CN",
    },
  });

  const seller2 = await prisma.user.create({
    data: {
      phone: "+8613900112233",
      email: "sales@shenzhen-lumica.test",
      name: "Li Mei",
      role: "SELLER",
      passcodeHash,
      onboardingDone: true,
      avatarUrl: IMG.avatarSeller2,
      locale: "CN",
    },
  });

  const admin = await prisma.user.create({
    data: {
      phone: "+2348000000001",
      email: "admin@magnetpay.test",
      name: "Magnet Admin",
      role: "BOTH",
      platformRole: "SUPER_ADMIN",
      passcodeHash,
      onboardingDone: true,
      avatarUrl: IMG.avatarBuyer,
    },
  });

  for (const currency of ["NGN", "CNY", "USD"] as const) {
    await ensureSystemAccounts(prisma, currency);
    for (const u of [buyer, buyer2, buyer3, seller, seller2]) {
      await ensureUserLedgerAccounts(prisma, u.id, currency);
    }
  }

  await prisma.wallet.createMany({
    data: [
      { userId: buyer.id, currency: "NGN", balanceMinor: 1_480_000_000n },
      { userId: buyer.id, currency: "USD", balanceMinor: 421_045n },
      { userId: buyer.id, currency: "CNY", balanceMinor: 8_654_020n },
      { userId: buyer2.id, currency: "NGN", balanceMinor: 250_000_000n },
      { userId: buyer2.id, currency: "CNY", balanceMinor: 1_200_000n },
      { userId: buyer2.id, currency: "USD", balanceMinor: 50_000n },
      { userId: buyer3.id, currency: "USD", balanceMinor: 180_000n },
      { userId: buyer3.id, currency: "CNY", balanceMinor: 900_000n },
      { userId: buyer3.id, currency: "NGN", balanceMinor: 0n },
      { userId: seller.id, currency: "CNY", balanceMinor: 2_500_000n },
      { userId: seller.id, currency: "USD", balanceMinor: 45_000n },
      { userId: seller.id, currency: "NGN", balanceMinor: 0n },
      { userId: seller2.id, currency: "CNY", balanceMinor: 1_800_000n },
      { userId: seller2.id, currency: "USD", balanceMinor: 22_000n },
      { userId: seller2.id, currency: "NGN", balanceMinor: 0n },
    ],
  });

  await prisma.fxRate.createMany({
    data: [
      { pair: "NGN_USD", rate: 0.00065, spreadBps: 50 },
      { pair: "USD_NGN", rate: 1540, spreadBps: 50 },
      { pair: "NGN_CNY", rate: 0.0047, spreadBps: 50 },
      { pair: "CNY_NGN", rate: 229.04, spreadBps: 50 },
      { pair: "USD_CNY", rate: 7.2, spreadBps: 40 },
      { pair: "CNY_USD", rate: 0.139, spreadBps: 40 },
    ],
  });

  await prisma.feeConfig.createMany({
    data: [
      { key: "escrow_fee_bps", value: 150 },
      { key: "transfer_fee_bps", value: 75 },
    ],
  });

  await prisma.freightPricing.create({
    data: { id: "default" },
  });

  await prisma.complianceLimits.create({
    data: { id: "default", ...DEFAULT_COMPLIANCE_LIMITS },
  });

  await prisma.logisticsPartner.createMany({
    data: [
      {
        name: "MagnetPay Logistics",
        code: "MAGNET",
        kind: "FREIGHT_FORWARDER",
        modes: ["SEA", "AIR", "EXPRESS", "CONSOLIDATED"],
        active: true,
        rating: 4.9,
        serviceLabel: "Door-to-door · China → Nigeria",
        contactName: "Ops Desk",
        contactPhone: "+2348000000001",
        contactEmail: "ops@magnetpay.test",
        notes: "Primary in-house freight partner.",
      },
      {
        name: "ChinaSea Express",
        code: "CHINASEA",
        kind: "FREIGHT_FORWARDER",
        modes: ["SEA", "CONSOLIDATED"],
        active: true,
        rating: 4.7,
        serviceLabel: "LCL · Guangzhou → Lagos",
      },
      {
        name: "Pacific Direct Freight",
        code: "PACIFIC",
        kind: "FREIGHT_FORWARDER",
        modes: ["SEA", "EXPRESS"],
        active: true,
        rating: 4.8,
        serviceLabel: "Express sea lane",
      },
      {
        name: "Maersk Consolidated",
        code: "MAERSK",
        kind: "FREIGHT_FORWARDER",
        modes: ["SEA", "CONSOLIDATED"],
        active: true,
        rating: 4.5,
        serviceLabel: "Port-to-port · bulk",
      },
    ],
  });

  const partnerRows = await prisma.logisticsPartner.findMany();
  const partnerByCode = Object.fromEntries(partnerRows.map((p) => [p.code, p.id]));
  await prisma.logisticsPartnerRate.createMany({
    data: [
      {
        id: "rate-magnet-sea",
        partnerId: partnerByCode.MAGNET!,
        mode: "SEA",
        rateMultiplierBps: 10000,
        etaLabel: "26–32 days",
        badgeLabel: "Best value",
        includes: ["Insurance", "Customs paperwork"],
        ecoFriendly: true,
        sortOrder: 0,
      },
      {
        id: "rate-chinasea-sea",
        partnerId: partnerByCode.CHINASEA!,
        mode: "SEA",
        rateMultiplierBps: 10000,
        etaLabel: "26–32 days",
        badgeLabel: "Best value",
        includes: ["Insurance", "Customs paperwork"],
        ecoFriendly: true,
        sortOrder: 1,
      },
      {
        id: "rate-pacific-sea",
        partnerId: partnerByCode.PACIFIC!,
        mode: "SEA",
        rateMultiplierBps: 12700,
        baseSurchargeMinor: 0,
        etaLabel: "22–26 days",
        badgeLabel: "Fastest sea",
        includes: ["Priority handling", "Insurance"],
        sortOrder: 2,
      },
      {
        id: "rate-maersk-sea",
        partnerId: partnerByCode.MAERSK!,
        mode: "SEA",
        rateMultiplierBps: 24500,
        etaLabel: "28–34 days",
        badgeLabel: "Best for bulk",
        includes: ["Insurance"],
        ecoFriendly: true,
        sortOrder: 3,
      },
    ],
  });

  await prisma.kycApplication.createMany({
    data: [
      { userId: buyer.id, type: "BVN", tier: 2, status: "APPROVED", payload: { bvn: "221*******" } },
      { userId: buyer2.id, type: "NIN", tier: 1, status: "APPROVED", payload: { nin: "123*******" } },
      { userId: seller.id, type: "CN_ID", tier: 1, status: "APPROVED", payload: { idNumber: "440*************" } },
      { userId: seller2.id, type: "BUSINESS", tier: 1, status: "SUBMITTED", payload: { license: "91440300****" } },
    ],
  });

  await prisma.businessProfile.createMany({
    data: [
      {
        userId: seller.id,
        companyName: "Guangzhou Huayi Trading Co., Ltd",
        licenseNo: "91440101MA5XXXXXXX",
        status: "APPROVED",
        documents: { province: "Guangdong" },
      },
      {
        userId: seller2.id,
        companyName: "Shenzhen Lumica Electronics",
        licenseNo: "91440300MA5YYYYYYY",
        status: "SUBMITTED",
        documents: { province: "Guangdong" },
      },
    ],
  });

  await prisma.recipient.createMany({
    data: [
      {
        userId: buyer.id,
        name: "Wei Chen",
        subtitle: "Guangzhou Huayi · WeChat",
        rail: "WECHAT",
        currency: "CNY",
        accountHint: "wxid_****chen",
        country: "CN",
        verificationStatus: "VERIFIED",
        verifiedAccountName: "Wei Chen",
        verificationMessage: "Name matched with payout provider",
        verifiedAt: new Date(),
      },
      {
        userId: buyer.id,
        name: "Guangzhou Huayi Trading",
        subtitle: "ICBC · Shenzhen",
        rail: "BANK",
        currency: "CNY",
        accountHint: "6228 **** 8891",
        country: "CN",
        verificationStatus: "VERIFIED",
        verifiedAccountName: "Guangzhou Huayi Trading",
        verificationMessage: "Name matched with payout provider",
        verifiedAt: new Date(),
      },
      {
        userId: buyer.id,
        name: "Li Mei",
        subtitle: "Alipay · Lumica",
        rail: "ALIPAY",
        currency: "CNY",
        accountHint: "li.mei@alipay.com",
        country: "CN",
        verificationStatus: "VERIFIED",
        verifiedAccountName: "Li Mei",
        verificationMessage: "Name matched with payout provider",
        verifiedAt: new Date(),
      },
      {
        userId: buyer.id,
        name: "Foshan Ceramics Ltd",
        subtitle: "Bank of China",
        rail: "BANK",
        currency: "CNY",
        accountHint: "****4412",
        country: "CN",
        verificationStatus: "VERIFIED",
        verifiedAccountName: "Foshan Ceramics Ltd",
        verificationMessage: "Name matched with payout provider",
        verifiedAt: new Date(),
      },
    ],
  });

  const cats = await Promise.all(
    [
      { slug: "machinery", name: "Machinery" },
      { slug: "electronics", name: "Electronics" },
      { slug: "apparel", name: "Apparel" },
      { slug: "beauty", name: "Beauty" },
      { slug: "industrial", name: "Industrial" },
      { slug: "home", name: "Home & Living" },
    ].map((c) => prisma.category.create({ data: c })),
  );
  const bySlug = Object.fromEntries(cats.map((c) => [c.slug, c]));

  const storeHuayi = await prisma.sellerStore.create({
    data: {
      userId: seller.id,
      name: "Guangzhou Huayi Trading Co.",
      description: "OEM pump bodies, fittings & industrial parts · 12 yrs export to Africa",
      verified: true,
    },
  });

  const storeLumica = await prisma.sellerStore.create({
    data: {
      userId: seller2.id,
      name: "Shenzhen Lumica Electronics",
      description: "LED panels, chargers & solar accessories · factory-direct",
      verified: true,
    },
  });

  type ProdSeed = {
    storeId: string;
    categoryId: string;
    title: string;
    description: string;
    priceMinor: bigint;
    currency: "CNY" | "USD";
    imageUrl: string;
    moq: string;
    rating: number;
    gallery: string[];
  };

  const productSeeds: ProdSeed[] = [
    {
      storeId: storeHuayi.id,
      categoryId: bySlug.machinery.id,
      title: "Cast-iron pump body PB-A2 · DN50",
      description:
        "Heavy-duty grey cast-iron pump body for industrial centrifugal pumps. Machined flanged DN50 connection rated for 1.6 MPa. Compatible with PB-A series impellers.",
      priceMinor: 5200n,
      currency: "CNY",
      imageUrl: IMG.pump,
      moq: "50 units",
      rating: 4.8,
      gallery: [IMG.pump, IMG.pump2, IMG.pump3, IMG.pump4, IMG.machinery],
    },
    {
      storeId: storeHuayi.id,
      categoryId: bySlug.industrial.id,
      title: "Steel pipe fittings · PN16 set",
      description: "Flanged fittings kit for industrial plumbing. Anti-corrosion coating.",
      priceMinor: 18500n,
      currency: "CNY",
      imageUrl: IMG.fittings,
      moq: "20 sets",
      rating: 4.6,
      gallery: [IMG.fittings, IMG.pump2],
    },
    {
      storeId: storeHuayi.id,
      categoryId: bySlug.industrial.id,
      title: "Industrial motor housing · 2.2kW",
      description: "Cast housing for AC motors. CNC finished mounting faces.",
      priceMinor: 8800n,
      currency: "CNY",
      imageUrl: IMG.machinery,
      moq: "30 units",
      rating: 4.7,
      gallery: [IMG.machinery, IMG.pump3],
    },
    {
      storeId: storeHuayi.id,
      categoryId: bySlug.home.id,
      title: "Ceramic floor tiles 600×600",
      description: "Porcelain tiles for commercial floors. Matt finish, PEI IV.",
      priceMinor: 3200n,
      currency: "CNY",
      imageUrl: IMG.tiles,
      moq: "200 m²",
      rating: 4.5,
      gallery: [IMG.tiles],
    },
    {
      storeId: storeLumica.id,
      categoryId: bySlug.electronics.id,
      title: "LED panel 600×600 · 40W",
      description: "Office ceiling LED panel, 4000K, flicker-free driver included.",
      priceMinor: 8800n,
      currency: "CNY",
      imageUrl: IMG.led,
      moq: "100 pcs",
      rating: 4.9,
      gallery: [IMG.led, IMG.electronics],
    },
    {
      storeId: storeLumica.id,
      categoryId: bySlug.electronics.id,
      title: "USB-C Hub 7-in-1 (Bulk OEM)",
      description: "HDMI 4K, USB 3.0 ×3, SD/TF, PD 100W. White-label ready.",
      priceMinor: 1850n,
      currency: "USD",
      imageUrl: IMG.electronics,
      moq: "100 pcs",
      rating: 4.8,
      gallery: [IMG.electronics, IMG.charger],
    },
    {
      storeId: storeLumica.id,
      categoryId: bySlug.electronics.id,
      title: "Solar inverter 3kW · hybrid",
      description: "Off-grid / hybrid inverter with MPPT. Ships with manuals EN/FR.",
      priceMinor: 22000n,
      currency: "USD",
      imageUrl: IMG.solar,
      moq: "10 pcs",
      rating: 4.6,
      gallery: [IMG.solar, IMG.charger],
    },
    {
      storeId: storeLumica.id,
      categoryId: bySlug.electronics.id,
      title: "EV wall charger 7kW",
      description: "Type 2 AC charger for residential install. IP54.",
      priceMinor: 45000n,
      currency: "CNY",
      imageUrl: IMG.charger,
      moq: "5 pcs",
      rating: 4.4,
      gallery: [IMG.charger],
    },
    {
      storeId: storeHuayi.id,
      categoryId: bySlug.apparel.id,
      title: "Polyester woven bags · 50kg",
      description: "PP woven sacks for grain & cement. Custom print available.",
      priceMinor: 290n,
      currency: "CNY",
      imageUrl: IMG.bags,
      moq: "5,000 pcs",
      rating: 4.7,
      gallery: [IMG.bags, IMG.textile],
    },
    {
      storeId: storeLumica.id,
      categoryId: bySlug.apparel.id,
      title: "Cotton jersey fabric rolls",
      description: "180gsm combed cotton. Colors: navy, ivory, black.",
      priceMinor: 4200n,
      currency: "CNY",
      imageUrl: IMG.textile,
      moq: "500 m",
      rating: 4.5,
      gallery: [IMG.textile],
    },
    {
      storeId: storeHuayi.id,
      categoryId: bySlug.industrial.id,
      title: "Corrugated mailer boxes · kraft",
      description: "E-flute mailers for e-commerce. Custom sizes on RFQ.",
      priceMinor: 180n,
      currency: "CNY",
      imageUrl: IMG.boxes,
      moq: "1,000 pcs",
      rating: 4.3,
      gallery: [IMG.boxes, IMG.mailers],
    },
    {
      storeId: storeLumica.id,
      categoryId: bySlug.beauty.id,
      title: "Cosmetic jars 50ml · frosted",
      description: "PET jars with aluminum lids. Branding foil available.",
      priceMinor: 120n,
      currency: "CNY",
      imageUrl: IMG.beauty,
      moq: "2,000 pcs",
      rating: 4.6,
      gallery: [IMG.beauty],
    },
  ];

  const products = [];
  for (const s of productSeeds) {
    const p = await prisma.product.create({
      data: {
        storeId: s.storeId,
        categoryId: s.categoryId,
        title: s.title,
        description: s.description,
        priceMinor: s.priceMinor,
        currency: s.currency,
        imageUrl: s.imageUrl,
        moq: s.moq,
        rating: s.rating,
        active: true,
        media: {
          create: s.gallery.map((url, i) => ({ url, sortOrder: i })),
        },
      },
    });
    products.push(p);
  }

  const pump = products[0];
  const led = products[4];
  const hub = products[5];

  await prisma.review.createMany({
    data: [
      {
        userId: buyer.id,
        productId: pump.id,
        rating: 5,
        comment: "Pump bodies arrived clean, machining was spot on. Will reorder.",
      },
      {
        userId: buyer2.id,
        productId: pump.id,
        rating: 4,
        comment: "Good quality but lead time slipped 4 days. Comms were solid throughout.",
      },
      {
        userId: buyer3.id,
        productId: pump.id,
        rating: 5,
        comment: "Smooth escrow release same day after BOL upload.",
      },
      {
        userId: buyer.id,
        productId: led.id,
        rating: 5,
        comment: "Panels are bright and consistent. Packed well for sea freight.",
      },
      {
        userId: buyer2.id,
        productId: hub.id,
        rating: 4,
        comment: "OEM branding worked. Minor QC on HDMI ports — supplier replaced batch.",
      },
    ],
  });

  await prisma.wishlistItem.createMany({
    data: [
      { userId: buyer.id, productId: pump.id },
      { userId: buyer.id, productId: led.id },
      { userId: buyer.id, productId: products[6].id },
    ],
  });

  await prisma.cart.create({
    data: {
      userId: buyer.id,
      items: {
        create: [
          { productId: pump.id, qty: 200 },
          { productId: led.id, qty: 50 },
        ],
      },
    },
  });

  const order1 = await prisma.marketOrder.create({
    data: {
      userId: buyer.id,
      status: "COMPLETED",
      totalMinor: 1_040_000n,
      currency: "CNY",
      supplier: storeHuayi.id,
      items: {
        create: [
          {
            productId: pump.id,
            title: pump.title,
            qty: 200,
            priceMinor: pump.priceMinor,
          },
        ],
      },
    },
  });

  await prisma.marketOrder.create({
    data: {
      userId: buyer.id,
      status: "SHIPPED",
      totalMinor: 440_000n,
      currency: "CNY",
      supplier: storeLumica.id,
      items: {
        create: [
          {
            productId: led.id,
            title: led.title,
            qty: 50,
            priceMinor: led.priceMinor,
          },
        ],
      },
    },
  });

  const rfq = await prisma.rfq.create({
    data: {
      buyerId: buyer.id,
      title: "Cast-iron pump bodies PB-A2 · 200 units",
      description: "FOB Guangzhou · target ¥52/unit · SGS inspection",
      qty: "200",
      status: "open",
      quotes: {
        create: [
          {
            sellerId: seller.id,
            amountMinor: 5400n,
            currency: "CNY",
            note: "FOB GZ · 21d lead · SGS OK",
          },
          {
            sellerId: seller2.id,
            amountMinor: 5800n,
            currency: "CNY",
            note: "FOB SZ · 18d lead",
          },
        ],
      },
    },
  });

  const escrow = await prisma.escrow.create({
    data: {
      title: "Pump body PB-A2 · 200 units",
      buyerId: buyer.id,
      sellerId: seller.id,
      amountMinor: 1_040_000n,
      currency: "CNY",
      status: "ACTIVE",
      progress: 0.25,
      inviteToken: "invite-demo-token",
      milestones: {
        create: [
          { label: "Production complete", amountMinor: 260_000n, sortOrder: 0, status: "RELEASED" },
          { label: "Goods dispatched", amountMinor: 260_000n, sortOrder: 1, status: "FUNDED" },
          { label: "Arrived at Apapa", amountMinor: 260_000n, sortOrder: 2, status: "PENDING" },
          { label: "Inspection pass", amountMinor: 260_000n, sortOrder: 3, status: "PENDING" },
        ],
      },
      documents: {
        create: [
          { name: "Proforma invoice", url: IMG.mailers },
          { name: "QC photos", url: IMG.pump2 },
        ],
      },
    },
  });

  await prisma.dispute.create({
    data: {
      escrowId: escrow.id,
      openedById: buyer.id,
      reason: "Surface finish below spec on 12 units",
      outcome: "split",
      evidence: {
        buyerRefundPercent: 35,
        messages: [
          {
            senderId: buyer.id,
            body: "QC photos show pitting on batch B-04.",
            at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    },
  });

  await prisma.wallet.update({
    where: { userId_currency: { userId: buyer.id, currency: "CNY" } },
    data: { holdMinor: { increment: 780_000n } },
  });

  const quoteReq = await prisma.shippingQuoteRequest.create({
    data: {
      userId: buyer.id,
      cargoDesc: "200 × pump bodies · wooden crates",
      cbm: 2.4,
      weightKg: 420,
      origin: "Guangzhou",
      destination: "Lagos",
      mode: "SEA",
    },
  });
  const quote = await prisma.shippingQuote.create({
    data: {
      requestId: quoteReq.id,
      estimatedMinor: 850_000_00n,
      currency: "NGN",
      validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  const shipment = await prisma.shipment.create({
    data: {
      userId: buyer.id,
      quoteId: quote.id,
      ref: "MSK-2210",
      route: "Guangzhou → Lagos",
      mode: "SEA",
      status: "IN_TRANSIT",
      eta: "14 days",
      hold: { create: { lockedMinor: 850_000_00n, currency: "NGN" } },
      events: {
        create: [
          { status: "HOLD_LOCKED", message: "Freight hold locked on NGN wallet" },
          { status: "CUSTOMS", message: "Cleared Guangzhou customs" },
          { status: "IN_TRANSIT", message: "Departed Shenzhen port · MSK-2210" },
        ],
      },
    },
  });

  await prisma.wallet.update({
    where: { userId_currency: { userId: buyer.id, currency: "NGN" } },
    data: { holdMinor: { increment: 850_000_00n } },
  });

  const recipients = await prisma.recipient.findMany({ where: { userId: buyer.id } });
  if (recipients[0]) {
    await prisma.transfer.create({
      data: {
        senderId: buyer.id,
        recipientId: recipients[0].id,
        currency: "CNY",
        amountMinor: 250_000n,
        note: "Sample payment",
        status: "SUCCEEDED",
        nombaRef: "NOMBA-DEMO-8841",
        events: {
          create: [
            { status: "CREATED", message: "Transfer created" },
            { status: "SUCCEEDED", message: "Paid out via WeChat" },
          ],
        },
      },
    });
  }

  await prisma.transaction.createMany({
    data: [
      {
        userId: buyer.id,
        kind: "inbound",
        title: "Wei Chen",
        subtitle: "Inbound payment · today",
        currency: "CNY",
        amountDisplay: "+¥2,500.00",
        amountPositive: true,
        icon: "arrow-down-left",
        color: "#0E3B2E",
        status: "SUCCEEDED",
      },
      {
        userId: buyer.id,
        kind: "shipment",
        title: "Container MSK-2210",
        subtitle: "Departed Shenzhen port",
        currency: "CNY",
        amountDisplay: "Update",
        status: "UPDATE",
        icon: "ship",
        color: "#0F766E",
      },
      {
        userId: buyer.id,
        kind: "order",
        title: `Order ${order1.id.slice(0, 8)}`,
        subtitle: "Pump body PB-A2 · completed",
        currency: "CNY",
        amountDisplay: "−¥10,400.00",
        amountPositive: false,
        status: "COMPLETED",
        icon: "package",
        color: "#C2410C",
      },
      {
        userId: buyer.id,
        kind: "escrow",
        title: "Escrow · pump bodies",
        subtitle: "Awaiting milestone release",
        currency: "CNY",
        amountDisplay: "Action",
        status: "ACTION",
        icon: "alert",
        color: "#B45309",
      },
      {
        userId: buyer.id,
        kind: "fx",
        title: "Converted NGN → CNY",
        subtitle: "FX settle",
        currency: "CNY",
        amountDisplay: "+¥12,000.00",
        amountPositive: true,
        status: "SUCCEEDED",
        icon: "repeat",
        color: "#0E3B2E",
      },
    ],
  });

  await prisma.notification.createMany({
    data: [
      {
        userId: buyer.id,
        title: "Escrow milestone ready",
        body: "Goods dispatched — review evidence and release funds.",
        read: false,
      },
      {
        userId: buyer.id,
        title: "Shipment update",
        body: "MSK-2210 departed Shenzhen for Lagos.",
        read: false,
      },
      {
        userId: buyer.id,
        title: "RFQ quotes received",
        body: "2 suppliers replied on pump body RFQ.",
        read: true,
      },
      {
        userId: buyer.id,
        title: "Welcome to MagnetPay",
        body: "Demo login: +2348123456789 · passcode 123456",
        read: true,
      },
      {
        userId: seller.id,
        title: "New escrow funded",
        body: "Chidi Okoro funded pump body escrow — upload dispatch docs.",
        read: false,
      },
    ],
  });

  const convo = await prisma.conversation.create({
    data: {
      subject: "Quote · Pump body PB-A2",
      participants: {
        create: [{ userId: buyer.id }, { userId: seller.id }],
      },
      messages: {
        create: [
          {
            senderId: seller.id,
            body: "Hi Chidi — attaching our latest quote for the 200-unit run at ¥54/unit FOB Guangzhou.",
            createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          },
          {
            senderId: buyer.id,
            body: "Can you match ¥52 if I bump to 300 units?",
            createdAt: new Date(Date.now() - 90 * 60 * 1000),
          },
          {
            senderId: seller.id,
            body: "We can do ¥51 at 300, same FOB terms. Escrow milestones as discussed.",
            createdAt: new Date(Date.now() - 60 * 60 * 1000),
          },
          {
            senderId: buyer.id,
            body: "Deal — I'll fund escrow today after SGS booking.",
            createdAt: new Date(Date.now() - 30 * 60 * 1000),
          },
        ],
      },
    },
  });

  await prisma.conversation.create({
    data: {
      subject: "LED panels · sample",
      participants: {
        create: [{ userId: buyer.id }, { userId: seller2.id }],
      },
      messages: {
        create: [
          {
            senderId: seller2.id,
            body: "Sample cartons shipped via SF Express. Tracking in the shipment tab.",
          },
          {
            senderId: buyer.id,
            body: "Received — brightness looks good. Sending RFQ for 500 units.",
          },
        ],
      },
    },
  });

  await seedAdminRecords();

  console.log("Seed complete — rich catalog with app images");
  console.log({
    buyer: { phone: buyer.phone, passcode: "123456", name: buyer.name },
    seller: { phone: seller.phone, passcode: "123456", name: seller.name },
    seller2: { phone: seller2.phone, passcode: "123456", name: seller2.name },
    admin: { phone: admin.phone, passcode: "123456" },
    products: products.length,
    categories: cats.length,
    escrowId: escrow.id,
    shipmentId: shipment.id,
    rfqId: rfq.id,
    conversationId: convo.id,
    orderId: order1.id,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
