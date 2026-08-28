import { prisma } from "../lib/prisma.js";

type SeedRow = {
  domain: string;
  externalId?: string;
  title: string;
  subtitle?: string;
  status?: string;
  payload?: Record<string, unknown>;
  sortOrder?: number;
};

const SEED: SeedRow[] = [
  // AML
  { domain: "aml", externalId: "AML-7741", title: "Ngozi Eze", subtitle: "Velocity — 4 deposits / 24h", status: "investigating", payload: { userId: "USR-09701", country: "NG", amountNGN: 1380000, txnId: "DEP-44112", riskScore: 82, severity: "high", assignee: "Tunde A.", ageHours: 3, notes: 4 } },
  { domain: "aml", externalId: "AML-7740", title: "Ibrahim Yusuf", subtitle: "Chargeback cluster on card BIN", status: "escalated", payload: { userId: "USR-09221", country: "NG", amountNGN: 603400, riskScore: 74, severity: "high", assignee: "Funke O.", ageHours: 49, notes: 7 } },
  { domain: "aml", externalId: "AML-7738", title: "Shenzhen TopMax", subtitle: "Large CNY withdrawal vs avg 30d", status: "new", payload: { userId: "SLR-2041", country: "CN", amountNGN: 20247000, riskScore: 58, severity: "medium", ageHours: 1, notes: 0 } },
  { domain: "aml", externalId: "AML-7714", title: "Yiwu PowerLine", subtitle: "Beneficiary mismatch vs KYB", status: "blocked", payload: { userId: "SLR-3092", country: "CN", amountNGN: 3252368, riskScore: 88, severity: "critical", assignee: "Funke O.", ageHours: 18, notes: 6 } },
  // Fraud
  { domain: "fraud", externalId: "FRC-5515", title: "Yiwu PowerLine", subtitle: "Seller collusion", status: "investigating", payload: { userId: "SLR-3092", country: "CN", lossNGN: 3252368, severity: "critical", assignee: "Funke O." } },
  { domain: "fraud", externalId: "FRC-5510", title: "Chioma Eze", subtitle: "Triangulation", status: "recovered", payload: { userId: "USR-08801", country: "NG", lossNGN: 412000, severity: "medium", assignee: "Tunde A." } },
  // Sanctions
  { domain: "sanctions", externalId: "SAN-9040", title: "Yiwu PowerLine Ltd", subtitle: "Director name", status: "open", payload: { subjectId: "SLR-3092", type: "seller", list: "EU Consolidated", score: 72, country: "CN" } },
  { domain: "sanctions", externalId: "SAN-9038", title: "Olu Bankole", subtitle: "Partial name", status: "false_positive", payload: { subjectId: "USR-10182", type: "user", list: "UN 1267", score: 48, country: "NG" } },
  // PEP
  { domain: "pep", externalId: "PEP-2204", title: "Joy Mensah", subtitle: "Spouse of regional minister", status: "cleared", payload: { country: "GH", relation: "Spouse", riskScore: 64 } },
  // SARs
  { domain: "sars", externalId: "SAR-1038", title: "Femi Adeyemi", subtitle: "Structuring pattern", status: "filed", payload: { userId: "USR-09584", amountNGN: 4820000, filedAt: "Jun 28" } },
  // Tickets
  { domain: "ticket", externalId: "TKT-8841", title: "Deposit not reflecting", subtitle: "Adaeze Okafor", status: "open", payload: { priority: "high", channel: "chat", assignee: "Mariam I.", slaHours: 4 } },
  { domain: "ticket", externalId: "TKT-8838", title: "Escrow release delay", subtitle: "Tolu Bankole", status: "pending", payload: { priority: "medium", channel: "email", assignee: "Support", slaHours: 12 } },
  // Brands / catalog meta
  { domain: "brand", externalId: "BRD-TM", title: "TopMax", status: "verified", payload: { listings: 142, country: "CN" } },
  { domain: "brand", externalId: "BRD-GS", title: "GoldStrand", status: "verified", payload: { listings: 210, country: "CN" } },
  { domain: "brand", externalId: "BRD-PL", title: "PowerLine", status: "pending", payload: { listings: 64, country: "CN" } },
  { domain: "collection", externalId: "COL-001", title: "Ramadan Essentials", status: "active", payload: { listings: 48, slot: "Home Hero", ends: "2026-08-14" } },
  { domain: "collection", externalId: "COL-002", title: "Back-to-School NG", status: "active", payload: { listings: 124, slot: "Market Row 1", ends: "2026-09-01" } },
  { domain: "coupon", externalId: "CPN-WELCOME10", title: "WELCOME10", status: "active", payload: { type: "Percent", value: "10%", uses: 4218, cap: 10000 } },
  { domain: "promotion", externalId: "PRM-2026-014", title: "Solar Week 2026", status: "running", payload: { type: "Category discount", discount: "15% OFF", uses: 412, budget: "$12,000" } },
  { domain: "banner", externalId: "BAN-001", title: "Solar Week — up to 15% OFF", status: "live", payload: { placement: "Home Hero", locale: "NG", ctr: "3.42%" } },
  // Settings / platform
  { domain: "feature-flag", externalId: "f_3", title: "seller.bulk_listing_csv", status: "staging", payload: { description: "CSV bulk upload for sellers with > 50 SKUs", prod: 0, owner: "@sellers" } },
  { domain: "webhook", externalId: "WH-001", title: "Order lifecycle → Alibaba", status: "active", payload: { url: "https://hooks.alibaba-ng.com/magnetpay/orders", successRate: 99.4 } },
  { domain: "team-member", externalId: "STF-0014", title: "Funke Oladipo", status: "active", payload: { role: "Compliance", email: "funke@magnetpay.ng" } },
  { domain: "warehouse", externalId: "WH-GZ-01", title: "Guangzhou Consolidation Hub", status: "active", payload: { country: "CN", capacityCbm: 4200, inbound7d: 128 } },
  { domain: "carrier", externalId: "CRR-SF", title: "SF Express CN", status: "active", payload: { modes: ["Air", "Express"], onTime: 96 } },
  { domain: "escrow-template", externalId: "TPL-STD", title: "Standard 3-milestone", status: "active", payload: { milestones: 3, holdDays: 14 } },
  { domain: "risk-rule", externalId: "RR-104", title: "Velocity — deposits 24h", status: "active", payload: { threshold: "4/day", action: "review" } },
  { domain: "allowlist", externalId: "ALW-2201", title: "SLR-2041 · Shenzhen TopMax", status: "active", payload: { kind: "user", reason: "Tier S strategic seller", hits: 9821 } },
  { domain: "blocklist", externalId: "BLK-4401", title: "BIN 478892", status: "active", payload: { kind: "card", reason: "Card testing cluster", hits: 412 } },
  { domain: "gdpr", externalId: "GDR-880", title: "Adaeze Okafor", subtitle: "Data export (Art. 15)", status: "processing", payload: { type: "export", daysLeft: 27, handler: "Funke O." } },
  { domain: "incident", externalId: "INC-441", title: "Paystack webhook delay", status: "resolved", payload: { severity: "medium", duration: "42m", owner: "Eng" } },
  { domain: "email-template", externalId: "EML-KYC", title: "KYC approved", status: "active", payload: { locale: "en", lastEdited: "Jun 12" } },
  { domain: "sms-template", externalId: "SMS-OTP", title: "Login OTP", status: "active", payload: { locale: "en", chars: 92 } },
  { domain: "legal-page", externalId: "LEGAL-PP", title: "Privacy Policy", status: "published", payload: { locale: "en", version: "v8.2" } },
  { domain: "help-article", externalId: "HLP-101", title: "How escrow release works", status: "published", payload: { views: 18420, locale: "en" } },
  { domain: "chargeback", externalId: "CB-9021", title: "ORD-527990", subtitle: "Card dispute", status: "open", payload: { amountNGN: 809100, reason: "Product not received" } },
  { domain: "seller-tier", externalId: "tier-pro", title: "Verified Pro", status: "active", payload: { sellers: 142, minGmv: 1000000 } },
  { domain: "seller-tier", externalId: "tier-verified", title: "Verified", status: "active", payload: { sellers: 612, minGmv: 100000 } },
  { domain: "seller-tier", externalId: "tier-new", title: "New", status: "active", payload: { sellers: 482, minGmv: 0 } },
];

export async function seedAdminRecords() {
  const count = await prisma.adminRecord.count();
  if (count > 0) return;

  for (let i = 0; i < SEED.length; i++) {
    const row = SEED[i];
    await prisma.adminRecord.create({
      data: {
        domain: row.domain,
        externalId: row.externalId,
        title: row.title,
        subtitle: row.subtitle,
        status: row.status,
        payload: row.payload ?? {},
        sortOrder: row.sortOrder ?? i,
      },
    });
  }
}
