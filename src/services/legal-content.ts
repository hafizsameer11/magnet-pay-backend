import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

function asJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export const DEFAULT_OPERATOR = {
  companyName: "MagnetPay Technologies Ltd.",
  lines: [
    "25 Marina Road, Lagos Island, Nigeria · CAC RC-1842901",
    "Licensed by the Central Bank of Nigeria · MMO 0042/24",
  ],
};

type LegalSeed = {
  externalId: string;
  title: string;
  subtitle: string;
  status: string;
  sortOrder: number;
  payload: Record<string, unknown>;
};

const LEGAL_PAGE_SEEDS: LegalSeed[] = [
  {
    externalId: "LEGAL-TOS",
    title: "Terms of Service",
    subtitle: "Updated 4 Jun 2026",
    status: "published",
    sortOrder: 1,
    payload: {
      slug: "terms",
      icon: "file-text",
      version: "v8.4",
      versionLabel: "Updated 4 Jun 2026",
      locale: "en",
      body: `These Terms of Service govern your use of MagnetPay's mobile app, website, escrow, wallet, and marketplace services.

By creating an account you agree to these terms, our Privacy Policy, and applicable escrow rules. You must be 18+ and legally able to enter contracts in your jurisdiction.

MagnetPay provides escrow, payments, FX conversion, and logistics coordination between buyers and sellers. We are not the seller of record on marketplace listings unless explicitly stated.

Fees: 0.9% on funded escrow plus ¥6 fixed per release unless otherwise disclosed at checkout. FX is at mid-market plus 0.35% spread.

Disputes must be opened within 7 calendar days of delivery confirmation. MagnetPay may hold, release, or refund escrow funds according to milestone status and dispute outcomes.

We may suspend accounts for AML, sanctions, fraud, or acceptable-use violations. Liability is limited to fees paid to MagnetPay in the 12 months before a claim, except where prohibited by law.

Contact: legal@magnetpay.io · MagnetPay Technologies Ltd., Lagos, Nigeria.`,
    },
  },
  {
    externalId: "LEGAL-PP",
    title: "Privacy policy",
    subtitle: "Updated 4 Jun 2026",
    status: "published",
    sortOrder: 2,
    payload: {
      slug: "privacy",
      icon: "shield-check",
      version: "v6.1",
      versionLabel: "Updated 4 Jun 2026",
      locale: "en",
      body: `MagnetPay Technologies Ltd. ("MagnetPay", "we") explains here how we collect, use, and protect personal data when you use our app and services.

We collect identity and contact data (name, phone, email), KYC/KYB documents, transaction and escrow history, device tokens for push notifications, and support messages. We use this to provide payments, comply with AML rules, prevent fraud, and improve the product.

We share data with payment processors, banks, logistics partners, and cloud providers only as needed to deliver the service. We do not sell personal data.

Retention: account and transaction records are kept for at least 7 years where required by AML law. Marketing preferences can be withdrawn anytime in Settings.

Your rights: access, correction, export, and deletion requests (subject to legal retention). Contact privacy@magnetpay.io or use in-app Legal → Request a data export.

International transfers may occur between Nigeria, China, and our subprocessors with appropriate safeguards.`,
    },
  },
  {
    externalId: "LEGAL-AML",
    title: "AML & sanctions policy",
    subtitle: "Updated 12 May 2026",
    status: "published",
    sortOrder: 3,
    payload: {
      slug: "aml",
      icon: "scale",
      version: "v4.0",
      versionLabel: "Updated 12 May 2026",
      locale: "en",
      body: `MagnetPay maintains an anti-money laundering and sanctions compliance program aligned with CBN regulations and FATF recommendations.

All users complete identity verification. Sellers complete enhanced KYB including beneficial ownership and bank account verification before payouts.

We screen users and transactions against sanctions lists (UN, OFAC, EU, NG) and monitor for unusual velocity, structuring, and beneficiary mismatches.

We file suspicious activity reports where required and may block, freeze, or delay transactions pending review. We do not tip off users about active investigations.

Prohibited: shell companies without substance, trade in sanctioned goods, third-party payments unrelated to the underlying order, and attempts to circumvent limits via multiple accounts.

Compliance contact: compliance@magnetpay.io`,
    },
  },
  {
    externalId: "LEGAL-ESCROW",
    title: "Escrow rules & dispute resolution",
    subtitle: "v3.2",
    status: "published",
    sortOrder: 4,
    payload: {
      slug: "escrow",
      icon: "scale",
      version: "v3.2",
      versionLabel: "v3.2",
      locale: "en",
      body: `Escrow funds are held by MagnetPay until milestones are approved by the buyer or released per order terms.

Standard milestones: deposit, production proof, bill of lading / shipment, and delivery confirmation. Custom templates may apply on negotiated orders.

Buyers may release early from the order page. Sellers may request release when evidence is uploaded. Auto-release timers apply when configured in the quote.

Disputes: open within 7 days of delivery. Both parties submit evidence (photos, tracking, inspection reports). MagnetPay mediators aim to resolve within 72 hours.

Outcomes may include full release, partial refund, full refund, or return logistics. FX on refunds uses mid-market + 0.35% at time of processing.

Force majeure: port closures, customs holds, or regulatory events may pause milestone timers until resolved.`,
    },
  },
  {
    externalId: "LEGAL-COOKIES",
    title: "Cookies & tracking",
    subtitle: "Updated 4 Jun 2026",
    status: "published",
    sortOrder: 5,
    payload: {
      slug: "cookies",
      icon: "cookie",
      version: "v2.0",
      versionLabel: "Updated 4 Jun 2026",
      locale: "en",
      body: `MagnetPay uses cookies and similar technologies on our website and in-app web views.

Strictly necessary: session authentication, security, and load balancing — always on.

Functional: language preference, saved draft forms, and UI settings.

Analytics: anonymized usage metrics to improve performance (can be disabled where offered).

Marketing: only with consent — promotional emails and push about features you opt into.

You can manage browser cookies in your device settings. In the app, use Settings → Notifications and Privacy controls.

We do not use third-party ad trackers in the mobile app.`,
    },
  },
  {
    externalId: "LEGAL-AUP",
    title: "Acceptable use policy",
    subtitle: "Updated 14 Feb 2026",
    status: "published",
    sortOrder: 6,
    payload: {
      slug: "aup",
      icon: "globe",
      version: "v1.3",
      versionLabel: "Updated 14 Feb 2026",
      locale: "en",
      body: `You may not use MagnetPay for illegal goods, weapons, controlled substances, wildlife products, counterfeit goods, or sanctions-evasion.

No off-platform payment requests in chat, no harassment, no impersonation of MagnetPay staff, and no automated scraping of marketplace data.

Sellers must accurately describe goods, honor quoted lead times, and ship with valid HS codes. Buyers must pay only through MagnetPay escrow for protected orders.

Violations may result in listing removal, escrow holds, account suspension, and referral to law enforcement.

Report abuse via Help → Chat with support or trust@magnetpay.io`,
    },
  },
  {
    externalId: "LEGAL-OPERATOR",
    title: "Operator disclosure",
    subtitle: "Company info",
    status: "published",
    sortOrder: 0,
    payload: {
      kind: "operator",
      companyName: DEFAULT_OPERATOR.companyName,
      lines: DEFAULT_OPERATOR.lines,
    },
  },
];

function mapLegalRow(row: {
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  payload: unknown;
  sortOrder: number;
}) {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    slug: String(payload.slug ?? ""),
    title: row.title,
    versionLabel: String(payload.versionLabel ?? row.subtitle ?? ""),
    icon: String(payload.icon ?? "file-text"),
    version: String(payload.version ?? ""),
    summary: typeof payload.summary === "string" ? payload.summary : undefined,
  };
}

export async function ensureLegalPagesSeed() {
  for (const seed of LEGAL_PAGE_SEEDS) {
    const existing = await prisma.adminRecord.findFirst({
      where: { domain: "legal-page", externalId: seed.externalId },
    });
    if (existing) {
      const current = (existing.payload ?? {}) as Record<string, unknown>;
      const needsBody = seed.payload.body && !current.body;
      const needsOperator = seed.payload.kind === "operator" && !current.companyName;
      if (needsBody || needsOperator) {
        await prisma.adminRecord.update({
          where: { id: existing.id },
          data: {
            title: seed.title,
            subtitle: seed.subtitle,
            status: seed.status,
            sortOrder: seed.sortOrder,
            payload: asJson({ ...current, ...seed.payload }),
          },
        });
      }
      continue;
    }
    await prisma.adminRecord.create({
      data: {
        domain: "legal-page",
        externalId: seed.externalId,
        title: seed.title,
        subtitle: seed.subtitle,
        status: seed.status,
        sortOrder: seed.sortOrder,
        payload: asJson(seed.payload),
      },
    });
  }
}

export async function getLegalOperator() {
  const row = await prisma.adminRecord.findFirst({
    where: { domain: "legal-page", externalId: "LEGAL-OPERATOR", status: "published" },
  });
  if (!row) return DEFAULT_OPERATOR;
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    companyName: String(payload.companyName ?? DEFAULT_OPERATOR.companyName),
    lines: Array.isArray(payload.lines)
      ? payload.lines.map(String)
      : DEFAULT_OPERATOR.lines,
  };
}

export async function listPublishedLegalPages() {
  const rows = await prisma.adminRecord.findMany({
    where: { domain: "legal-page", status: "published" },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows
    .filter((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      return p.kind !== "operator" && p.slug;
    })
    .map(mapLegalRow);
}

export async function getPublishedLegalPage(slug: string) {
  const rows = await prisma.adminRecord.findMany({
    where: { domain: "legal-page", status: "published" },
    take: 50,
  });
  const row = rows.find((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    return p.slug === slug;
  });
  if (!row) return null;
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  return {
    ...mapLegalRow(row),
    body: String(payload.body ?? ""),
    locale: String(payload.locale ?? "en"),
  };
}
