import bcrypt from "bcryptjs";
import type { Merchant } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/** Common weak 6-digit PINs refused for till passcodes. */
export const WEAK_PASSCODES = new Set([
  "000000",
  "111111",
  "222222",
  "333333",
  "444444",
  "555555",
  "666666",
  "777777",
  "888888",
  "999999",
  "123456",
  "654321",
  "112233",
  "121212",
  "123123",
  "101010",
]);

const MAX_FAILS = 4;
const LOCKOUT_MS = 15 * 60 * 1000;

export function isWeakPasscode(pin: string): boolean {
  return WEAK_PASSCODES.has(pin);
}

export type PasscodeResult =
  | { ok: true }
  | { ok: false; code: "LOCKED" | "INVALID" | "NOT_SET"; message: string; lockedUntil?: Date };

export async function verifyTillPasscode(
  merchant: Pick<Merchant, "id" | "passcodeHash" | "passcodeFailCount" | "lockedUntil">,
  pin: string,
): Promise<PasscodeResult> {
  if (merchant.lockedUntil && merchant.lockedUntil > new Date()) {
    return {
      ok: false,
      code: "LOCKED",
      message: "Till locked after too many failed attempts",
      lockedUntil: merchant.lockedUntil,
    };
  }

  if (!merchant.passcodeHash) {
    return { ok: false, code: "NOT_SET", message: "Till passcode not set" };
  }

  const match = await bcrypt.compare(pin, merchant.passcodeHash);
  if (match) {
    if (merchant.passcodeFailCount > 0 || merchant.lockedUntil) {
      await prisma.merchant.update({
        where: { id: merchant.id },
        data: { passcodeFailCount: 0, lockedUntil: null },
      });
    }
    return { ok: true };
  }

  const nextFails = merchant.passcodeFailCount + 1;
  if (nextFails >= MAX_FAILS) {
    const lockedUntil = new Date(Date.now() + LOCKOUT_MS);
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { passcodeFailCount: nextFails, lockedUntil },
    });
    return {
      ok: false,
      code: "LOCKED",
      message: "Till locked after 4 failed attempts",
      lockedUntil,
    };
  }

  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { passcodeFailCount: nextFails },
  });
  return {
    ok: false,
    code: "INVALID",
    message: `Wrong passcode · ${MAX_FAILS - nextFails} attempt(s) left`,
  };
}

export async function setPasscode(merchantId: string, pin: string): Promise<{ ok: true }> {
  if (!/^\d{6}$/.test(pin)) {
    throw new Error("Passcode must be 6 digits");
  }
  if (isWeakPasscode(pin)) {
    throw new Error("Passcode is too weak");
  }
  const passcodeHash = await bcrypt.hash(pin, 10);
  await prisma.merchant.update({
    where: { id: merchantId },
    data: { passcodeHash, passcodeFailCount: 0, lockedUntil: null },
  });
  return { ok: true };
}
