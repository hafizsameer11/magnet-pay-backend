import { prisma } from "../lib/prisma.js";

export type NameCheckKind = "phone" | "meter" | "smartcard" | "account" | "wallet" | "bvn" | "nin" | string;

export type NameCheckResult =
  | { ok: true; name: string }
  | { ok: false; name?: string; message: string };

function normalizeNgPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && (digits.startsWith("7") || digits.startsWith("8") || digits.startsWith("9"))) {
    return `+234${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("0")) {
    return `+234${digits.slice(1)}`;
  }
  if (digits.length === 13 && digits.startsWith("234")) {
    return `+${digits}`;
  }
  if (digits.length >= 10 && digits.length <= 15) {
    return raw.trim().startsWith("+") ? `+${digits}` : `+${digits}`;
  }
  return null;
}

function phoneCandidates(raw: string): string[] {
  const out = new Set<string>();
  const normalized = normalizeNgPhone(raw);
  if (normalized) out.add(normalized);
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 10) {
    out.add(`+${digits}`);
    out.add(`+234${digits.slice(-10)}`);
    if (digits.startsWith("0") && digits.length === 11) out.add(`+234${digits.slice(1)}`);
  }
  return [...out];
}

/** Resolve MagnetPay wallet by phone, @tag (uXXXXXXXXXX), or user id. */
export async function resolveWalletNameCheck(value: string): Promise<NameCheckResult> {
  const v = String(value ?? "").trim();
  if (v.length < 3) {
    return { ok: false, message: "Enter a valid wallet ID, tag, or phone" };
  }

  // UUID user id
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    const user = await prisma.user.findUnique({ where: { id: v }, select: { name: true, phone: true } });
    if (!user) return { ok: false, message: "No MagnetPay wallet found for that ID" };
    return { ok: true, name: user.name || user.phone };
  }

  const tag = v.replace(/^@/, "").trim();
  // Client QR tags: u + last 10 phone digits
  if (/^u\d{10}$/i.test(tag)) {
    const last10 = tag.slice(1);
    const phones = phoneCandidates(last10);
    for (const phone of phones) {
      const user = await prisma.user.findUnique({ where: { phone }, select: { name: true, phone: true } });
      if (user) return { ok: true, name: user.name || user.phone };
    }
    // Scan all users ending with those digits (handles +234 / 234 variants already stored)
    const users = await prisma.user.findMany({
      where: { phone: { endsWith: last10 } },
      select: { name: true, phone: true },
      take: 1,
    });
    if (users[0]) return { ok: true, name: users[0].name || users[0].phone };
    return { ok: false, message: "No MagnetPay wallet found for that tag" };
  }

  // Phone-like input
  const phones = phoneCandidates(v);
  for (const phone of phones) {
    const user = await prisma.user.findUnique({ where: { phone }, select: { name: true, phone: true } });
    if (user) return { ok: true, name: user.name || user.phone };
  }
  if (phones.length) {
    const last10 = phones[0]!.replace(/\D/g, "").slice(-10);
    const users = await prisma.user.findMany({
      where: { phone: { endsWith: last10 } },
      select: { name: true, phone: true },
      take: 1,
    });
    if (users[0]) return { ok: true, name: users[0].name || users[0].phone };
  }

  // Name-like @handle — match users whose derived tag would equal this (name slug)
  if (/^[a-z0-9_.]{3,24}$/i.test(tag) && !/^\d+$/.test(tag)) {
    const slug = tag.toLowerCase();
    const users = await prisma.user.findMany({
      where: { name: { not: "" } },
      select: { name: true, phone: true },
      take: 200,
    });
    const hit = users.find((u) => {
      const derived = (u.name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ".")
        .replace(/^\.+|\.+$/g, "")
        .slice(0, 18);
      return derived === slug;
    });
    if (hit) return { ok: true, name: hit.name || hit.phone };
  }

  return { ok: false, message: "No MagnetPay wallet found. Use phone, @tag, or scan their QR." };
}

/**
 * Name enquiry — wallet/phone resolve against real users; other kinds stay stubbed
 * until NIBSS / biller providers are wired.
 */
export async function nameCheck(kind: NameCheckKind, value: string): Promise<NameCheckResult> {
  const v = String(value ?? "").trim();
  if (!v) {
    return { ok: false, message: "Value required" };
  }

  if (kind === "wallet" || kind === "phone") {
    return resolveWalletNameCheck(v);
  }

  return stubNameCheck(kind, v);
}

/** Sync stub for billers / bank / KYC fields (no live provider yet). */
export function stubNameCheck(kind: NameCheckKind, value: string): NameCheckResult {
  const v = String(value ?? "").trim();
  if (!v) {
    return { ok: false, message: "Value required" };
  }

  const digits = v.replace(/\D/g, "");

  switch (kind) {
    case "phone":
      if (digits.length < 10 || digits.length > 14) {
        return { ok: false, message: "Enter a valid phone number" };
      }
      return { ok: true, name: "Adaeze Okonkwo" };
    case "meter":
      if (digits.length < 8 || digits.length > 13) {
        return { ok: false, message: "Enter a valid meter number" };
      }
      return { ok: true, name: "IKEJA ELECTRIC · PREPAID" };
    case "smartcard":
      if (digits.length < 8 || digits.length > 14) {
        return { ok: false, message: "Enter a valid smartcard / IUC number" };
      }
      return { ok: true, name: "CHUKWUMA EMEKA" };
    case "account":
      if (digits.length !== 10) {
        return { ok: false, message: "Account number must be 10 digits" };
      }
      return { ok: true, name: "IKEJA UNION VENTURES" };
    case "wallet":
      if (v.length < 3) {
        return { ok: false, message: "Enter a valid wallet ID, tag, or phone" };
      }
      return { ok: true, name: "Emeka Nwosu" };
    case "bvn":
      if (digits.length !== 11) {
        return { ok: false, message: "BVN must be 11 digits" };
      }
      return { ok: true, name: "IKEJA UNION" };
    case "nin":
      if (digits.length !== 11) {
        return { ok: false, message: "NIN must be 11 digits" };
      }
      return { ok: true, name: "IKEJA UNION" };
    default:
      if (v.length < 4) {
        return { ok: false, message: "Value too short" };
      }
      return { ok: true, name: "Verified Customer" };
  }
}
