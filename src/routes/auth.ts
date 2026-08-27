import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { createHash, randomInt } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { fail, ok, requireAuth, serialize, signAccess, signRefresh, verifyRefresh } from "../lib/http.js";
import { ensureSystemAccounts, ensureUserLedgerAccounts } from "../services/ledger.js";
import { isSmtpConfigured, isValidEmail, normalizeEmail, sendOtpEmail } from "../services/email.js";

export const authRouter = Router();

function hashOtp(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

function normalizePhone(phone: string) {
  return phone.replace(/\s+/g, "").trim();
}

function exposeDebugCode() {
  // Hide on-screen code once real SMTP is configured (or in production).
  return process.env.NODE_ENV !== "production" && !isSmtpConfigured();
}

authRouter.post("/otp/request", async (req, res) => {
  const body = z
    .object({
      phone: z.string().min(8),
      email: z.string().email().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "phone required");

  const phone = normalizePhone(body.data.phone);
  let email = body.data.email ? normalizeEmail(body.data.email) : "";

  if (email && !isValidEmail(email)) {
    return fail(res, 400, "VALIDATION", "Valid email required");
  }

  // Forgot-passcode / existing users: resolve email from account when not provided
  if (!email) {
    const existing = await prisma.user.findUnique({ where: { phone } });
    if (!existing?.email) {
      return fail(
        res,
        400,
        "EMAIL_REQUIRED",
        "Email is required. Sign up with an email, or add email on your profile first.",
      );
    }
    email = normalizeEmail(existing.email);
  }

  // Signup path: email must not already belong to another phone
  const emailOwner = await prisma.user.findUnique({ where: { email } });
  if (emailOwner && emailOwner.phone !== phone) {
    return fail(res, 400, "EMAIL_IN_USE", "This email is already registered with another account");
  }

  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await prisma.otpChallenge.create({
    data: { phone, email, codeHash: hashOtp(code), expiresAt },
  });

  try {
    await sendOtpEmail(email, code);
  } catch (e) {
    return fail(res, 502, "EMAIL_SEND_FAILED", e instanceof Error ? e.message : "Could not send email");
  }

  return ok(res, {
    phone,
    email,
    expiresAt,
    channel: "email" as const,
    ...(exposeDebugCode() ? { debugCode: code } : {}),
  });
});

authRouter.post("/otp/verify", async (req, res) => {
  const body = z
    .object({
      phone: z.string(),
      code: z.string().length(6),
      email: z.string().email().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "phone and 6-digit code required");

  const phone = normalizePhone(body.data.phone);
  const email = body.data.email ? normalizeEmail(body.data.email) : undefined;

  const challenge = await prisma.otpChallenge.findFirst({
    where: {
      phone,
      consumedAt: null,
      ...(email ? { email } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge || challenge.expiresAt < new Date() || challenge.codeHash !== hashOtp(body.data.code)) {
    return fail(res, 400, "INVALID_OTP", "Invalid or expired code");
  }
  await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });

  const verifiedEmail = email ?? challenge.email;

  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    const emailTaken = await prisma.user.findUnique({ where: { email: verifiedEmail } });
    if (emailTaken) {
      return fail(res, 400, "EMAIL_IN_USE", "This email is already registered with another account");
    }
    user = await prisma.user.create({
      data: { phone, email: verifiedEmail, role: "BUYER" },
    });
    for (const currency of ["NGN", "CNY", "USD"] as const) {
      await prisma.wallet.create({ data: { userId: user.id, currency, balanceMinor: 0n } });
      await prisma.$transaction(async (tx) => {
        await ensureSystemAccounts(tx, currency);
        await ensureUserLedgerAccounts(tx, user!.id, currency);
      });
    }
  } else if (!user.email && verifiedEmail) {
    const emailTaken = await prisma.user.findUnique({ where: { email: verifiedEmail } });
    if (emailTaken && emailTaken.id !== user.id) {
      return fail(res, 400, "EMAIL_IN_USE", "This email is already registered with another account");
    }
    user = await prisma.user.update({
      where: { id: user.id },
      data: { email: verifiedEmail },
    });
  }

  return ok(res, {
    userId: user.id,
    phone: user.phone,
    email: user.email,
    needsPasscode: !user.passcodeHash,
  });
});

authRouter.post("/passcode/set", async (req, res) => {
  const body = z.object({ phone: z.string(), passcode: z.string().length(6) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "phone and 6-digit passcode required");
  const phone = normalizePhone(body.data.phone);
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) return fail(res, 404, "NOT_FOUND", "User not found");
  const passcodeHash = await bcrypt.hash(body.data.passcode, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passcodeHash } });
  return ok(res, { ok: true });
});

authRouter.post("/passcode/verify", requireAuth, async (req, res) => {
  const body = z.object({ passcode: z.string().length(6) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "6-digit passcode required");
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user?.passcodeHash) return fail(res, 401, "INVALID_PASSCODE", "Passcode not set");
  const match = await bcrypt.compare(body.data.passcode, user.passcodeHash);
  if (!match) return fail(res, 401, "INVALID_PASSCODE", "Wrong passcode");
  return ok(res, { ok: true });
});

authRouter.post("/login", async (req, res) => {
  const body = z
    .object({ phone: z.string(), passcode: z.string().length(6) })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "phone and passcode required");
  const phone = normalizePhone(body.data.phone);
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user?.passcodeHash) return fail(res, 401, "INVALID_CREDENTIALS", "Wrong phone or passcode");
  const match = await bcrypt.compare(body.data.passcode, user.passcodeHash);
  if (!match) return fail(res, 401, "INVALID_CREDENTIALS", "Wrong phone or passcode");

  const authUser = { id: user.id, role: user.role, platformRole: user.platformRole };
  const accessToken = signAccess(authUser);
  const refreshToken = signRefresh(authUser);
  const refreshTokenHash = createHash("sha256").update(refreshToken).digest("hex");
  await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  return ok(res, {
    accessToken,
    refreshToken,
    user: serialize({
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      role: user.role,
      platformRole: user.platformRole,
      avatarUrl: user.avatarUrl,
      onboardingDone: user.onboardingDone,
    }),
  });
});

authRouter.post("/refresh", async (req, res) => {
  const body = z.object({ refreshToken: z.string() }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "refreshToken required");
  try {
    const payload = verifyRefresh(body.data.refreshToken);
    const hash = createHash("sha256").update(body.data.refreshToken).digest("hex");
    const session = await prisma.session.findFirst({
      where: { userId: payload.id, refreshTokenHash: hash, expiresAt: { gt: new Date() } },
    });
    if (!session) return fail(res, 401, "UNAUTHORIZED", "Invalid refresh");
    const accessToken = signAccess({
      id: payload.id,
      role: payload.role,
      platformRole: payload.platformRole,
    });
    return ok(res, { accessToken });
  } catch {
    return fail(res, 401, "UNAUTHORIZED", "Invalid refresh");
  }
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  await prisma.session.deleteMany({ where: { userId: req.user!.id } });
  return ok(res, { ok: true });
});
