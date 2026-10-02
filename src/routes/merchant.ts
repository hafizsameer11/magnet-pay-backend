import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Merchant, MerchantDocKind } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  fail,
  ok,
  requireAuth,
  serialize,
  param,
  signAccess,
  signRefresh,
  verifyAccess,
  type AuthUser,
} from "../lib/http.js";
import { verifyTillPasscode, setPasscode, isWeakPasscode } from "../services/merchant-auth.js";
import { createOnboard, getKyb, uploadDoc, resubmit } from "../services/merchant-kyb.js";
import { getFloat, topUpDigital } from "../services/merchant-float.js";
import { listSettlements, settleNow } from "../services/merchant-settlement.js";
import {
  quoteFees,
  startCashOut,
  confirmCashOut,
  cancelCashOut,
  cashIn,
  transfer,
  guestDisplayVa,
} from "../services/merchant-serve.js";
import { listBillers, verifyBill, payBill } from "../services/merchant-bills.js";
import { listAgents } from "../services/merchant-directory.js";
import { stubNameCheck } from "../services/merchant-name-check.js";
import { ensureSystemAccounts, ensureUserLedgerAccounts } from "../services/ledger.js";

export const merchantRouter = Router();
export const agentsRouter = Router();

type MerchantRequest = Request & { merchant?: Merchant };

async function loadMerchant(userId: string) {
  return prisma.merchant.findUnique({ where: { userId } });
}

function requireMerchant(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, async () => {
    try {
      if (!req.user || req.user.role !== "MERCHANT") {
        return fail(res, 403, "FORBIDDEN", "Merchant account required");
      }
      const merchant = await loadMerchant(req.user.id);
      if (!merchant) {
        return fail(res, 403, "FORBIDDEN", "Merchant profile not found");
      }
      (req as MerchantRequest).merchant = merchant;
      next();
    } catch (e) {
      next(e);
    }
  });
}

function toMinor(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.round(v));
  if (typeof v === "string" && v.length) return BigInt(v);
  throw new Error("Invalid amount");
}

function rangeStart(range?: string): Date | undefined {
  const now = Date.now();
  if (!range || range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (range === "7d") return new Date(now - 7 * 24 * 60 * 60 * 1000);
  if (range === "30d") return new Date(now - 30 * 24 * 60 * 60 * 1000);
  return undefined;
}

// ── Public agent directory ──────────────────────────────────────────────────
async function agentsHandler(req: Request, res: Response) {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const lga = typeof req.query.lga === "string" ? req.query.lga : undefined;
  const nearLat =
    typeof req.query.lat === "string" ? Number(req.query.lat) : undefined;
  const nearLng =
    typeof req.query.lng === "string" ? Number(req.query.lng) : undefined;
  const rows = await listAgents({
    q,
    state,
    lga,
    nearLat: Number.isFinite(nearLat) ? nearLat : undefined,
    nearLng: Number.isFinite(nearLng) ? nearLng : undefined,
  });
  return ok(res, serialize(rows));
}

agentsRouter.get("/", agentsHandler);
merchantRouter.get("/agents", agentsHandler);

// ── Auth ────────────────────────────────────────────────────────────────────
merchantRouter.post("/auth/login", async (req, res) => {
  const body = z
    .object({
      agentId: z.string().optional(),
      phone: z.string().optional(),
      passcode: z.string().length(6),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "agentId|phone and passcode required");
  if (!body.data.agentId && !body.data.phone) {
    return fail(res, 400, "VALIDATION", "agentId or phone required");
  }

  const merchant = await prisma.merchant.findFirst({
    where: body.data.agentId
      ? { agentId: body.data.agentId }
      : { phone: body.data.phone!.replace(/\s+/g, "").trim() },
    include: { user: true },
  });
  if (!merchant) return fail(res, 401, "INVALID_CREDENTIALS", "Wrong agent ID or passcode");

  const check = await verifyTillPasscode(merchant, body.data.passcode);
  if (!check.ok) {
    const status = check.code === "LOCKED" ? 423 : 401;
    return fail(res, status, check.code, check.message);
  }

  const user = merchant.user;
  const authUser: AuthUser = {
    id: user.id,
    role: user.role,
    platformRole: user.platformRole,
  };
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
      onboardingDone: user.onboardingDone,
    }),
    merchant: serialize({
      id: merchant.id,
      agentId: merchant.agentId,
      tag: merchant.tag,
      businessName: merchant.businessName,
      status: merchant.status,
      tier: merchant.tier,
    }),
  });
});

merchantRouter.post("/auth/reset", async (req, res) => {
  const body = z
    .object({
      step: z.enum(["request", "verify", "set"]),
      agentId: z.string().optional(),
      phone: z.string().optional(),
      otp: z.string().optional(),
      bvnLast4: z.string().optional(),
      passcode: z.string().length(6).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid reset payload");

  if (body.data.step === "request") {
    return ok(res, { ok: true, step: "verify", message: "OTP stub sent" });
  }
  if (body.data.step === "verify") {
    return ok(res, { ok: true, step: "set", verified: true });
  }
  if (body.data.step === "set") {
    if (!body.data.passcode || isWeakPasscode(body.data.passcode)) {
      return fail(res, 400, "WEAK_PASSCODE", "Passcode is too weak");
    }
    const merchant = await prisma.merchant.findFirst({
      where: body.data.agentId
        ? { agentId: body.data.agentId }
        : { phone: body.data.phone?.replace(/\s+/g, "").trim() },
    });
    if (!merchant) return fail(res, 404, "NOT_FOUND", "Merchant not found");
    if (body.data.bvnLast4 && merchant.bvnLast4 && body.data.bvnLast4 !== merchant.bvnLast4) {
      return fail(res, 400, "INVALID_BVN", "BVN last 4 does not match");
    }
    await setPasscode(merchant.id, body.data.passcode);
    await prisma.session.deleteMany({ where: { userId: merchant.userId } });
    return ok(res, { ok: true });
  }
  return fail(res, 400, "VALIDATION", "Unknown step");
});

function tryAuthUser(req: Request): AuthUser | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  try {
    return verifyAccess(header.slice(7));
  } catch {
    return null;
  }
}

function normalizeMerchantPhone(phone: string) {
  return phone.replace(/\s+/g, "").trim();
}

async function issueMerchantSession(user: { id: string; role: string; platformRole: string }) {
  const authUser: AuthUser = {
    id: user.id,
    role: user.role,
    platformRole: user.platformRole,
  };
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
  return { accessToken, refreshToken, authUser };
}

merchantRouter.post("/onboard", async (req, res) => {
  const body = z
    .object({
      businessName: z.string().min(2),
      businessType: z.enum(["REGISTERED", "UNREGISTERED"]).optional(),
      category: z.string().optional(),
      address: z.string().optional(),
      state: z.string().optional(),
      lga: z.string().optional(),
      phone: z.string().min(8),
      ownerName: z.string().min(2),
      bvn: z.string().optional(),
      nin: z.string().optional(),
      settlementBank: z.string().optional(),
      settlementAccount: z.string().optional(),
      settlementAccountName: z.string().optional(),
      passcode: z.string().length(6).optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid onboard payload");

  const phone = normalizeMerchantPhone(body.data.phone);
  if (phone.length < 8) return fail(res, 400, "VALIDATION", "Valid phone required");

  try {
    let userId = tryAuthUser(req)?.id;
    if (!userId) {
      let user = await prisma.user.findUnique({ where: { phone } });
      if (!user) {
        user = await prisma.user.create({
          data: {
            phone,
            name: body.data.ownerName,
            role: "MERCHANT",
            onboardingDone: true,
          },
        });
        for (const currency of ["NGN", "CNY", "USD"] as const) {
          await prisma.wallet.create({ data: { userId: user.id, currency, balanceMinor: 0n } });
          await prisma.$transaction(async (tx) => {
            await ensureSystemAccounts(tx, currency);
            await ensureUserLedgerAccounts(tx, user!.id, currency);
          });
        }
      } else if (await prisma.merchant.findUnique({ where: { userId: user.id } })) {
        return fail(res, 400, "ONBOARD_FAILED", "Merchant profile already exists for this phone");
      }
      userId = user.id;
    }

    const merchant = await createOnboard({ userId, ...body.data, phone });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const session = await issueMerchantSession(user);

    return ok(
      res,
      {
        ...serialize(merchant),
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        user: serialize({
          id: user.id,
          phone: user.phone,
          name: user.name,
          email: user.email,
          role: user.role,
          platformRole: user.platformRole,
          onboardingDone: user.onboardingDone,
        }),
      },
      201,
    );
  } catch (e) {
    return fail(res, 400, "ONBOARD_FAILED", e instanceof Error ? e.message : "Onboard failed");
  }
});

// ── Me ──────────────────────────────────────────────────────────────────────
merchantRouter.get("/me", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const full = await prisma.merchant.findUnique({
    where: { id: m.id },
    include: { float: true, documents: true },
  });
  return ok(res, serialize(full));
});

merchantRouter.patch("/me", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z
    .object({
      businessName: z.string().optional(),
      category: z.string().optional(),
      address: z.string().optional(),
      state: z.string().optional(),
      lga: z.string().optional(),
      phone: z.string().optional(),
      openHours: z.any().optional(),
      listedInDirectory: z.boolean().optional(),
      settlementBank: z.string().optional(),
      settlementAccount: z.string().optional(),
      settlementAccountName: z.string().optional(),
      passcode: z.string().length(6).optional(),
      currentPasscode: z.string().length(6).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid body");

  if (body.data.passcode) {
    if (!body.data.currentPasscode) {
      return fail(res, 400, "VALIDATION", "currentPasscode required");
    }
    const check = await verifyTillPasscode(m, body.data.currentPasscode);
    if (!check.ok) return fail(res, 401, check.code, check.message);
    try {
      await setPasscode(m.id, body.data.passcode);
    } catch (e) {
      return fail(res, 400, "WEAK_PASSCODE", e instanceof Error ? e.message : "Invalid passcode");
    }
  }

  const bankChanging =
    (body.data.settlementBank && body.data.settlementBank !== m.settlementBank) ||
    (body.data.settlementAccount && body.data.settlementAccount !== m.settlementAccount);

  if (bankChanging && body.data.settlementBank && body.data.settlementAccount) {
    await prisma.settlementBankChange.create({
      data: {
        merchantId: m.id,
        oldBank: m.settlementBank,
        oldAccount: m.settlementAccount,
        newBank: body.data.settlementBank,
        newAccount: body.data.settlementAccount,
        newAccountName: body.data.settlementAccountName,
        pauseUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
        status: "PENDING",
      },
    });
  }

  const { passcode: _p, currentPasscode: _c, ...rest } = body.data;
  const updated = await prisma.merchant.update({
    where: { id: m.id },
    data: rest,
  });
  return ok(res, serialize(updated));
});

// ── KYB ─────────────────────────────────────────────────────────────────────
merchantRouter.get("/kyb", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  return ok(res, serialize(await getKyb(m.id)));
});

merchantRouter.post("/kyb/documents", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z
    .object({
      kind: z.enum(["CAC", "GOV_ID", "SHOP_PHOTO", "UTILITY"]),
      fileUrl: z.string().min(1),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "kind and fileUrl required");
  const doc = await uploadDoc({
    merchantId: m.id,
    kind: body.data.kind as MerchantDocKind,
    fileUrl: body.data.fileUrl,
  });
  return ok(res, serialize(doc), 201);
});

merchantRouter.post("/kyb/resubmit", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  try {
    return ok(res, serialize(await resubmit(m.id)));
  } catch (e) {
    return fail(res, 400, "RESUBMIT_FAILED", e instanceof Error ? e.message : "Failed");
  }
});

// ── Float ───────────────────────────────────────────────────────────────────
merchantRouter.get("/float", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  return ok(res, serialize(await getFloat(m.id)));
});

merchantRouter.post("/float/top-up", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z.object({ amountMinor: z.union([z.number(), z.string()]) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "amountMinor required");
  try {
    const row = await topUpDigital(m.id, toMinor(body.data.amountMinor));
    return ok(res, serialize(row));
  } catch (e) {
    return fail(res, 400, "TOP_UP_FAILED", e instanceof Error ? e.message : "Failed");
  }
});

// ── Activity / tx ───────────────────────────────────────────────────────────
merchantRouter.get("/activity", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const rows = await prisma.merchantTransaction.findMany({
    where: {
      merchantId: m.id,
      ...(kind && kind !== "ALL" ? { kind: kind as "CASH_IN" | "CASH_OUT" | "BILL" | "TRANSFER" } : {}),
      ...(q
        ? {
            OR: [
              { ref: { contains: q } },
              { counterpartyName: { contains: q } },
              { counterparty: { contains: q } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok(res, serialize(rows));
});

merchantRouter.get("/tx/:ref", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const row = await prisma.merchantTransaction.findFirst({
    where: { merchantId: m.id, ref: param(req, "ref") },
    include: { biller: true },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Transaction not found");
  return ok(res, serialize(row));
});

// ── Earnings ────────────────────────────────────────────────────────────────
merchantRouter.get("/earnings", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const range = typeof req.query.range === "string" ? req.query.range : "today";
  const since = rangeStart(range);
  const txs = await prisma.merchantTransaction.findMany({
    where: {
      merchantId: m.id,
      status: "COMPLETED",
      ...(since ? { createdAt: { gte: since } } : {}),
    },
  });
  const agentEarned = txs.reduce((s, t) => s + t.agentFeeMinor, 0n);
  const platformFees = txs.reduce((s, t) => s + t.platformFeeMinor, 0n);
  const volume = txs.reduce((s, t) => {
    const a = t.amountMinor < 0n ? -t.amountMinor : t.amountMinor;
    return s + a;
  }, 0n);
  const byKind: Record<string, { count: number; volume: string; fees: string }> = {};
  for (const t of txs) {
    const k = t.kind;
    if (!byKind[k]) byKind[k] = { count: 0, volume: "0", fees: "0" };
    const a = t.amountMinor < 0n ? -t.amountMinor : t.amountMinor;
    byKind[k]!.count += 1;
    byKind[k]!.volume = String(BigInt(byKind[k]!.volume) + a);
    byKind[k]!.fees = String(BigInt(byKind[k]!.fees) + t.agentFeeMinor);
  }
  const settlements = await listSettlements(m.id, 20);
  const fresh = await prisma.merchant.findUniqueOrThrow({ where: { id: m.id } });
  return ok(
    res,
    serialize({
      range,
      agentEarnedMinor: agentEarned,
      platformFeeMinor: platformFees,
      volumeMinor: volume,
      txCount: txs.length,
      byKind,
      unpaidEarningsMinor: fresh.unpaidEarningsMinor,
      settlements,
      tier: fresh.tier,
      dailyLimit: fresh.dailyLimit,
    }),
  );
});

merchantRouter.post("/earnings/settle", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  try {
    return ok(res, serialize(await settleNow(m.id)));
  } catch (e) {
    return fail(res, 400, "SETTLE_FAILED", e instanceof Error ? e.message : "Failed");
  }
});

// ── Serve ───────────────────────────────────────────────────────────────────
merchantRouter.post("/serve/quote", requireMerchant, async (req, res) => {
  const body = z
    .object({
      service: z.enum(["CASH_OUT", "CASH_IN", "BILL", "TRANSFER"]),
      amountMinor: z.union([z.number(), z.string()]),
      agentFeeMinor: z.union([z.number(), z.string()]).optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "service and amountMinor required");
  const quote = await quoteFees(
    body.data.service,
    toMinor(body.data.amountMinor),
    body.data.agentFeeMinor != null ? toMinor(body.data.agentFeeMinor) : null,
  );
  return ok(res, serialize(quote));
});

merchantRouter.post("/serve/cash-out", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z
    .object({
      amountMinor: z.union([z.number(), z.string()]),
      agentFeeMinor: z.union([z.number(), z.string()]).optional().nullable(),
      counterparty: z.string().optional().nullable(),
      counterpartyName: z.string().optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "amountMinor required");
  try {
    const row = await startCashOut({
      merchantId: m.id,
      amountMinor: toMinor(body.data.amountMinor),
      agentFeeMinor: body.data.agentFeeMinor != null ? toMinor(body.data.agentFeeMinor) : null,
      counterparty: body.data.counterparty,
      counterpartyName: body.data.counterpartyName,
    });
    const va = await guestDisplayVa(m.id);
    return ok(res, serialize({ ...row, va }), 201);
  } catch (e) {
    return fail(res, 400, "CASH_OUT_FAILED", e instanceof Error ? e.message : "Failed");
  }
});

merchantRouter.post("/serve/cash-in", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z
    .object({
      amountMinor: z.union([z.number(), z.string()]),
      agentFeeMinor: z.union([z.number(), z.string()]).optional().nullable(),
      phone: z.string().optional().nullable(),
      walletTag: z.string().optional().nullable(),
      counterpartyName: z.string().optional().nullable(),
      bankAccount: z.string().optional().nullable(),
      bankName: z.string().optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "amountMinor required");
  try {
    const row = await cashIn({
      merchantId: m.id,
      amountMinor: toMinor(body.data.amountMinor),
      agentFeeMinor: body.data.agentFeeMinor != null ? toMinor(body.data.agentFeeMinor) : null,
      phone: body.data.phone,
      walletTag: body.data.walletTag,
      counterpartyName: body.data.counterpartyName,
      bankAccount: body.data.bankAccount,
      bankName: body.data.bankName,
    });
    return ok(res, serialize(row), 201);
  } catch (e) {
    return fail(res, 400, "CASH_IN_FAILED", e instanceof Error ? e.message : "Failed");
  }
});

merchantRouter.post("/serve/transfer", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z
    .object({
      amountMinor: z.union([z.number(), z.string()]),
      destination: z.string().min(3),
      agentFeeMinor: z.union([z.number(), z.string()]).optional().nullable(),
      counterpartyName: z.string().optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "amountMinor and destination required");
  try {
    const row = await transfer({
      merchantId: m.id,
      amountMinor: toMinor(body.data.amountMinor),
      destination: body.data.destination,
      agentFeeMinor: body.data.agentFeeMinor != null ? toMinor(body.data.agentFeeMinor) : null,
      counterpartyName: body.data.counterpartyName,
    });
    return ok(res, serialize(row), 201);
  } catch (e) {
    return fail(res, 400, "TRANSFER_FAILED", e instanceof Error ? e.message : "Failed");
  }
});

merchantRouter.post("/serve/confirm", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z.object({ ref: z.string().min(3) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "ref required");
  try {
    return ok(res, serialize(await confirmCashOut(m.id, body.data.ref)));
  } catch (e) {
    return fail(res, 400, "CONFIRM_FAILED", e instanceof Error ? e.message : "Failed");
  }
});

merchantRouter.post("/serve/cancel", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z.object({ ref: z.string().min(3) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "ref required");
  try {
    return ok(res, serialize(await cancelCashOut(m.id, body.data.ref)));
  } catch (e) {
    return fail(res, 400, "CANCEL_FAILED", e instanceof Error ? e.message : "Failed");
  }
});

merchantRouter.get("/serve/guest-va", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  return ok(res, serialize(await guestDisplayVa(m.id)));
});

// ── Bills ───────────────────────────────────────────────────────────────────
merchantRouter.get("/billers", requireMerchant, async (req, res) => {
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  return ok(res, serialize(await listBillers(category)));
});

merchantRouter.post("/bills/verify", requireMerchant, async (req, res) => {
  const body = z
    .object({
      billerId: z.string(),
      account: z.string().min(4),
      prepaid: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "billerId and account required");
  const result = await verifyBill(body.data);
  if (!result.ok) return fail(res, 400, "VERIFY_FAILED", result.message);
  return ok(res, serialize(result));
});

merchantRouter.post("/bills/pay", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z
    .object({
      billerId: z.string(),
      account: z.string().min(4),
      amountMinor: z.union([z.number(), z.string()]).optional(),
      agentFeeMinor: z.union([z.number(), z.string()]).optional().nullable(),
      planId: z.string().optional().nullable(),
      prepaid: z.boolean().optional(),
      counterpartyName: z.string().optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid bill pay payload");
  try {
    const row = await payBill({
      merchantId: m.id,
      billerId: body.data.billerId,
      account: body.data.account,
      amountMinor: body.data.amountMinor != null ? toMinor(body.data.amountMinor) : 0n,
      agentFeeMinor: body.data.agentFeeMinor != null ? toMinor(body.data.agentFeeMinor) : null,
      planId: body.data.planId,
      prepaid: body.data.prepaid,
      counterpartyName: body.data.counterpartyName,
    });
    return ok(res, serialize(row), 201);
  } catch (e) {
    return fail(res, 400, "PAY_FAILED", e instanceof Error ? e.message : "Failed");
  }
});

/** Stub enquiry — public so merchant onboard can verify BVN/account before a session exists. */
merchantRouter.post("/name-check", async (req, res) => {
  const body = z
    .object({
      kind: z.enum(["phone", "meter", "smartcard", "account", "wallet", "bvn", "nin"]),
      value: z.string().min(1),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "kind and value required");
  return ok(res, stubNameCheck(body.data.kind, body.data.value));
});

merchantRouter.get("/fees", requireMerchant, async (_req, res) => {
  const rules = await prisma.merchantFeeRule.findMany({ orderBy: { service: "asc" } });
  return ok(res, serialize(rules));
});

merchantRouter.post("/disputes", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z
    .object({
      txRef: z.string().min(3),
      reason: z.string().min(3),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "txRef and reason required");
  const tx = await prisma.merchantTransaction.findFirst({
    where: { merchantId: m.id, ref: body.data.txRef },
  });
  if (!tx) return fail(res, 404, "NOT_FOUND", "Transaction not found");
  const row = await prisma.merchantDispute.create({
    data: {
      merchantId: m.id,
      txRef: body.data.txRef,
      reason: body.data.reason,
      status: "open",
    },
  });
  await prisma.merchantTransaction.update({
    where: { ref: body.data.txRef },
    data: { status: "DISPUTED" },
  });
  return ok(res, serialize(row), 201);
});

merchantRouter.get("/tiers", requireMerchant, async (_req, res) => {
  const rules = await prisma.merchantTierRule.findMany({ orderBy: { monthlyVolumeThreshold: "asc" } });
  return ok(res, serialize(rules));
});

merchantRouter.get("/alerts", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const float = await getFloat(m.id);
  const pending = await prisma.merchantTransaction.findMany({
    where: { merchantId: m.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const docs = await prisma.merchantDocument.findMany({
    where: { merchantId: m.id, status: "REJECTED" },
  });
  const settlements = await prisma.merchantSettlement.findMany({
    where: { merchantId: m.id, status: "QUEUED" },
    take: 5,
  });
  const alerts: {
    id: string;
    type: string;
    title: string;
    subtitle: string;
    href: string;
    createdAt: string;
    unread: boolean;
  }[] = [];

  if (float.lowCash) {
    alerts.push({
      id: `low-cash-${m.id}`,
      type: "low_cash",
      title: "Cash on hand is running low",
      subtitle: `₦${(Number(float.cashMinor) / 100).toLocaleString("en-NG")} left — top up float`,
      href: "/merchant/float",
      createdAt: new Date().toISOString(),
      unread: true,
    });
  }
  for (const tx of pending) {
    alerts.push({
      id: `tx-${tx.ref}`,
      type: "pending_tx",
      title: `Waiting · ${tx.ref}`,
      subtitle: tx.counterpartyName || tx.counterparty || tx.kind,
      href: `/merchant/tx/${tx.ref}`,
      createdAt: tx.createdAt.toISOString(),
      unread: true,
    });
  }
  for (const d of docs) {
    alerts.push({
      id: `doc-${d.id}`,
      type: "doc_rejected",
      title: "A document needs attention",
      subtitle: d.rejectReason || `${d.kind} was rejected`,
      href: "/merchant/kyb",
      createdAt: d.updatedAt.toISOString(),
      unread: true,
    });
  }
  for (const s of settlements) {
    alerts.push({
      id: `settle-${s.id}`,
      type: "settlement",
      title: "Earnings queued for settlement",
      subtitle: `${s.bank} · ${s.status}`,
      href: "/merchant/earnings",
      createdAt: s.createdAt.toISOString(),
      unread: false,
    });
  }
  return ok(res, serialize(alerts));
});

// ── Staff / branches / referrals ────────────────────────────────────────────
merchantRouter.get("/staff", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const rows = await prisma.merchantStaff.findMany({ where: { merchantId: m.id } });
  return ok(res, serialize(rows));
});

merchantRouter.post("/staff", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z
    .object({
      name: z.string().min(1),
      phone: z.string().min(8),
      role: z.string().default("cashier"),
      permissions: z.any().optional(),
      passcode: z.string().length(6).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid staff payload");
  const passcodeHash = body.data.passcode ? await bcrypt.hash(body.data.passcode, 10) : null;
  const row = await prisma.merchantStaff.create({
    data: {
      merchantId: m.id,
      name: body.data.name,
      phone: body.data.phone,
      role: body.data.role,
      permissions: body.data.permissions ?? undefined,
      passcodeHash,
    },
  });
  return ok(res, serialize(row), 201);
});

merchantRouter.patch("/staff/:id", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const id = param(req, "id");
  const body = z
    .object({
      active: z.boolean().optional(),
      role: z.string().optional(),
      permissions: z.any().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid body");
  const existing = await prisma.merchantStaff.findFirst({ where: { id, merchantId: m.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Staff not found");
  const row = await prisma.merchantStaff.update({
    where: { id },
    data: {
      active: body.data.active,
      role: body.data.role,
      permissions: body.data.permissions ?? undefined,
    },
  });
  return ok(res, serialize(row));
});

merchantRouter.get("/branches", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const rows = await prisma.merchantBranch.findMany({ where: { merchantId: m.id } });
  return ok(res, serialize(rows));
});

merchantRouter.post("/branches", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z
    .object({
      name: z.string().min(1),
      address: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "name required");
  const row = await prisma.merchantBranch.create({
    data: {
      merchantId: m.id,
      name: body.data.name,
      address: body.data.address ?? "",
    },
  });
  return ok(res, serialize(row), 201);
});

merchantRouter.get("/referrals", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const rows = await prisma.merchantReferral.findMany({
    where: { referrerId: m.id },
    include: { referred: { select: { agentId: true, businessName: true, status: true } } },
  });
  return ok(res, serialize(rows));
});

merchantRouter.post("/referrals", requireMerchant, async (req, res) => {
  const m = (req as MerchantRequest).merchant!;
  const body = z.object({ referredAgentId: z.string() }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "referredAgentId required");
  const referred = await prisma.merchant.findUnique({ where: { agentId: body.data.referredAgentId } });
  if (!referred) return fail(res, 404, "NOT_FOUND", "Referred merchant not found");
  try {
    const row = await prisma.merchantReferral.create({
      data: {
        referrerId: m.id,
        referredId: referred.id,
        rewardMinor: 500000n,
        status: "pending",
      },
    });
    return ok(res, serialize(row), 201);
  } catch {
    return fail(res, 400, "EXISTS", "Referral already recorded");
  }
});
