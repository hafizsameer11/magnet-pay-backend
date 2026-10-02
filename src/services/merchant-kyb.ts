import { randomInt } from "node:crypto";
import type { MerchantBusinessType, MerchantDocKind } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { isWeakPasscode, setPasscode } from "./merchant-auth.js";
import { stubNameCheck } from "./merchant-name-check.js";

const STARTER_DAILY_LIMIT = 30_000_000; // ₦300,000
const UNREGISTERED_DAILY_LIMIT = 15_000_000;

async function nextAgentId(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = `MP-AG-${String(randomInt(1000, 9999))}`;
    const exists = await prisma.merchant.findUnique({ where: { agentId: candidate } });
    if (!exists) return candidate;
  }
  return `MP-AG-${Date.now().toString().slice(-4)}`;
}

function slugTag(businessName: string) {
  const base = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 24);
  return `@${base || "agent"}${randomInt(10, 99)}`;
}

export async function createOnboard(opts: {
  userId: string;
  businessName: string;
  businessType?: MerchantBusinessType;
  category?: string;
  address?: string;
  state?: string;
  lga?: string;
  phone: string;
  ownerName: string;
  bvn?: string;
  nin?: string;
  settlementBank?: string;
  settlementAccount?: string;
  settlementAccountName?: string;
  passcode?: string;
  lat?: number;
  lng?: number;
}) {
  const existing = await prisma.merchant.findUnique({ where: { userId: opts.userId } });
  if (existing) {
    throw new Error("Merchant profile already exists");
  }

  if (opts.passcode) {
    if (!/^\d{6}$/.test(opts.passcode) || isWeakPasscode(opts.passcode)) {
      throw new Error("Passcode is weak or invalid");
    }
  }

  if (opts.bvn) {
    const check = stubNameCheck("bvn", opts.bvn);
    if (!check.ok) throw new Error(check.message);
  }

  if (opts.settlementAccount) {
    const check = stubNameCheck("account", opts.settlementAccount);
    if (!check.ok) throw new Error(check.message);
  }

  const businessType = opts.businessType ?? "REGISTERED";
  const agentId = await nextAgentId();
  const tag = slugTag(opts.businessName);
  const dailyLimit =
    businessType === "UNREGISTERED" ? UNREGISTERED_DAILY_LIMIT : STARTER_DAILY_LIMIT;

  const merchant = await prisma.$transaction(async (db) => {
    await db.user.update({
      where: { id: opts.userId },
      data: { role: "MERCHANT", name: opts.ownerName || opts.businessName },
    });

    const m = await db.merchant.create({
      data: {
        userId: opts.userId,
        agentId,
        tag,
        businessName: opts.businessName,
        businessType,
        category: opts.category ?? "General",
        address: opts.address ?? "",
        state: opts.state ?? "Lagos",
        lga: opts.lga ?? "Ikeja",
        lat: opts.lat,
        lng: opts.lng,
        phone: opts.phone,
        ownerName: opts.ownerName,
        bvnLast4: opts.bvn ? opts.bvn.replace(/\D/g, "").slice(-4) : null,
        bvnVerified: Boolean(opts.bvn),
        ninVerified: Boolean(opts.nin),
        status: "PENDING",
        tier: "SILVER",
        dailyLimit,
        settlementBank: opts.settlementBank,
        settlementAccount: opts.settlementAccount,
        settlementAccountName: opts.settlementAccountName,
        vaBank: "Wema Bank",
        vaAccountNumber: `7829${agentId.replace(/\D/g, "").padStart(6, "0").slice(-6)}`,
        float: { create: { cashMinor: 0n, digitalMinor: 0n } },
      },
    });
    return m;
  });

  if (opts.passcode) {
    await setPasscode(merchant.id, opts.passcode);
  }

  return prisma.merchant.findUniqueOrThrow({
    where: { id: merchant.id },
    include: { documents: true, float: true },
  });
}

export async function getKyb(merchantId: string) {
  return prisma.merchant.findUniqueOrThrow({
    where: { id: merchantId },
    include: { documents: { orderBy: { createdAt: "asc" } } },
  });
}

export async function uploadDoc(opts: {
  merchantId: string;
  kind: MerchantDocKind;
  fileUrl: string;
}) {
  const existing = await prisma.merchantDocument.findFirst({
    where: { merchantId: opts.merchantId, kind: opts.kind, status: { in: ["PENDING", "REJECTED"] } },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    return prisma.merchantDocument.update({
      where: { id: existing.id },
      data: {
        fileUrl: opts.fileUrl,
        status: "PENDING",
        rejectReason: null,
        reviewedAt: null,
        reviewedById: null,
      },
    });
  }

  return prisma.merchantDocument.create({
    data: {
      merchantId: opts.merchantId,
      kind: opts.kind,
      fileUrl: opts.fileUrl,
      status: "PENDING",
    },
  });
}

export async function resubmit(merchantId: string) {
  const docs = await prisma.merchantDocument.findMany({ where: { merchantId } });
  const rejected = docs.filter((d) => d.status === "REJECTED");
  if (rejected.length) {
    throw new Error("Re-upload rejected documents before resubmitting");
  }
  const merchant = await prisma.merchant.update({
    where: { id: merchantId },
    data: { status: "PENDING" },
    include: { documents: true },
  });
  return merchant;
}
