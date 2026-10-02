import { Router } from "express";
import { z } from "zod";
import type { MerchantDocStatus, MerchantStatus, MerchantTier } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { fail, ok, requireAdmin, serialize, param, inputJson } from "../lib/http.js";
import { topUpDigital, LOW_CASH_THRESHOLD_MINOR } from "../services/merchant-float.js";
import { listAgents } from "../services/merchant-directory.js";

export const adminMerchantsRouter = Router();
adminMerchantsRouter.use(requireAdmin);

function toMinor(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.round(v));
  if (typeof v === "string" && v.length) return BigInt(v);
  throw new Error("Invalid amount");
}

async function audit(
  actorId: string | undefined,
  action: string,
  entity: string,
  entityId: string | undefined,
  meta?: unknown,
) {
  await prisma.auditLog.create({
    data: {
      actorId: actorId ?? null,
      action,
      entity,
      entityId: entityId ?? null,
      meta: meta != null ? inputJson(meta) : undefined,
    },
  });
}

// ── Overview ────────────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/overview", async (req, res) => {
  const sinceParam = typeof req.query.since === "string" ? req.query.since : "today";
  let since = new Date();
  since.setHours(0, 0, 0, 0);
  if (sinceParam === "7d") since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  if (sinceParam === "30d") since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [active, pending, suspended, closed, txs, kybPending, lowFloat] = await Promise.all([
    prisma.merchant.count({ where: { status: "ACTIVE" } }),
    prisma.merchant.count({ where: { status: "PENDING" } }),
    prisma.merchant.count({ where: { status: "SUSPENDED" } }),
    prisma.merchant.count({ where: { status: "CLOSED" } }),
    prisma.merchantTransaction.findMany({
      where: { createdAt: { gte: since }, status: "COMPLETED" },
      select: {
        amountMinor: true,
        platformFeeMinor: true,
        agentFeeMinor: true,
      },
    }),
    prisma.merchantDocument.count({ where: { status: "PENDING" } }),
    prisma.merchantFloat.count({ where: { cashMinor: { lte: LOW_CASH_THRESHOLD_MINOR } } }),
  ]);

  let volume = 0n;
  let platformFee = 0n;
  let agentEarnings = 0n;
  for (const t of txs) {
    const a = t.amountMinor < 0n ? -t.amountMinor : t.amountMinor;
    volume += a;
    platformFee += t.platformFeeMinor;
    agentEarnings += t.agentFeeMinor;
  }

  const failedPending = await prisma.merchantTransaction.count({
    where: { status: { in: ["FAILED", "PENDING"] }, createdAt: { gte: since } },
  });

  const topAgents = await prisma.merchant.findMany({
    where: { status: "ACTIVE" },
    take: 10,
    orderBy: { unpaidEarningsMinor: "desc" },
    select: {
      id: true,
      agentId: true,
      businessName: true,
      tier: true,
      unpaidEarningsMinor: true,
    },
  });

  return ok(
    res,
    serialize({
      counts: { active, pending, suspended, closed },
      volumeMinor: volume,
      txCount: txs.length,
      platformFeeMinor: platformFee,
      agentEarningsMinor: agentEarnings,
      kybQueue: kybPending,
      failedOrPendingTx: failedPending,
      lowFloatAgents: lowFloat,
      topAgents,
      since: since.toISOString(),
    }),
  );
});

// ── List / detail ───────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const tier = typeof req.query.tier === "string" ? req.query.tier : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;

  const rows = await prisma.merchant.findMany({
    where: {
      ...(status ? { status: status as MerchantStatus } : {}),
      ...(tier ? { tier: tier as MerchantTier } : {}),
      ...(state ? { state } : {}),
      ...(q
        ? {
            OR: [
              { businessName: { contains: q } },
              { agentId: { contains: q } },
              { phone: { contains: q } },
              { tag: { contains: q } },
            ],
          }
        : {}),
    },
    include: { float: true, user: { select: { id: true, email: true, phone: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok(res, serialize(rows));
});

// ── KYB ─────────────────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/kyb", async (_req, res) => {
  const docs = await prisma.merchantDocument.findMany({
    where: { status: "PENDING" },
    include: {
      merchant: {
        select: {
          id: true,
          agentId: true,
          businessName: true,
          businessType: true,
          status: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return ok(res, serialize(docs));
});

adminMerchantsRouter.post("/merchants/kyb/:docId/decide", async (req, res) => {
  const docId = param(req, "docId");
  const body = z
    .object({
      status: z.enum(["APPROVED", "REJECTED"]),
      rejectReason: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "status required");
  if (body.data.status === "REJECTED" && !body.data.rejectReason) {
    return fail(res, 400, "VALIDATION", "rejectReason required");
  }

  const doc = await prisma.merchantDocument.update({
    where: { id: docId },
    data: {
      status: body.data.status as MerchantDocStatus,
      rejectReason: body.data.rejectReason ?? null,
      reviewedById: req.user!.id,
      reviewedAt: new Date(),
    },
    include: { merchant: true },
  });

  await prisma.notification.create({
    data: {
      userId: doc.merchant.userId,
      title: body.data.status === "APPROVED" ? "Document approved" : "Document rejected",
      body:
        body.data.status === "APPROVED"
          ? `${doc.kind} was approved`
          : `${doc.kind} rejected: ${body.data.rejectReason}`,
      href: "/merchant/kyb",
    },
  });

  await audit(req.user?.id, "merchant.kyb.decide", "MerchantDocument", docId, body.data);
  return ok(res, serialize(doc));
});

// ── Transactions ────────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/transactions", async (req, res) => {
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const merchantId = typeof req.query.merchantId === "string" ? req.query.merchantId : undefined;
  const rows = await prisma.merchantTransaction.findMany({
    where: {
      ...(kind ? { kind: kind as "CASH_IN" | "CASH_OUT" | "BILL" | "TRANSFER" } : {}),
      ...(status
        ? { status: status as "PENDING" | "COMPLETED" | "FAILED" | "REVERSED" | "DISPUTED" }
        : {}),
      ...(merchantId ? { merchantId } : {}),
    },
    include: {
      merchant: { select: { agentId: true, businessName: true } },
      biller: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok(res, serialize(rows));
});

adminMerchantsRouter.get("/merchants/transactions/:ref", async (req, res) => {
  const row = await prisma.merchantTransaction.findUnique({
    where: { ref: param(req, "ref") },
    include: {
      merchant: true,
      biller: true,
      disputes: true,
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Transaction not found");
  return ok(res, serialize(row));
});

adminMerchantsRouter.post("/merchants/transactions/:ref/reverse", async (req, res) => {
  const ref = param(req, "ref");
  const body = z
    .object({
      reason: z.string().min(3),
      approverId: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "reason required");

  const row = await prisma.merchantTransaction.findUnique({ where: { ref } });
  if (!row) return fail(res, 404, "NOT_FOUND", "Not found");
  if (row.status === "REVERSED") return fail(res, 400, "ALREADY", "Already reversed");

  const updated = await prisma.merchantTransaction.update({
    where: { id: row.id },
    data: {
      status: "REVERSED",
      meta: inputJson({
        ...(typeof row.meta === "object" && row.meta ? row.meta : {}),
        reverseReason: body.data.reason,
        reversedBy: req.user!.id,
        secondApprover: body.data.approverId ?? null,
      }),
    },
  });

  if (row.agentFeeMinor > 0n) {
    await prisma.merchant.update({
      where: { id: row.merchantId },
      data: { unpaidEarningsMinor: { decrement: row.agentFeeMinor } },
    });
  }

  await audit(req.user?.id, "merchant.tx.reverse", "MerchantTransaction", row.id, body.data);
  return ok(res, serialize(updated));
});

// ── Disputes ────────────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/disputes", async (_req, res) => {
  const rows = await prisma.merchantDispute.findMany({
    include: { merchant: { select: { agentId: true, businessName: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok(res, serialize(rows));
});

adminMerchantsRouter.post("/merchants/disputes", async (req, res) => {
  const body = z
    .object({
      merchantId: z.string(),
      txRef: z.string().optional().nullable(),
      reason: z.string().min(3),
      assigneeId: z.string().optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid dispute");
  const row = await prisma.merchantDispute.create({
    data: {
      merchantId: body.data.merchantId,
      txRef: body.data.txRef ?? null,
      reason: body.data.reason,
      assigneeId: body.data.assigneeId ?? null,
      status: "open",
    },
  });
  if (body.data.txRef) {
    await prisma.merchantTransaction.updateMany({
      where: { ref: body.data.txRef },
      data: { status: "DISPUTED" },
    });
  }
  await audit(req.user?.id, "merchant.dispute.create", "MerchantDispute", row.id, body.data);
  return ok(res, serialize(row), 201);
});

// ── Settlements ─────────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/settlements", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const rows = await prisma.merchantSettlement.findMany({
    where: status
      ? { status: status as "QUEUED" | "PAID" | "FAILED" | "HELD" }
      : undefined,
    include: { merchant: { select: { agentId: true, businessName: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok(res, serialize(rows));
});

adminMerchantsRouter.post("/merchants/settlements/:id/retry", async (req, res) => {
  const id = param(req, "id");
  const row = await prisma.merchantSettlement.findUnique({ where: { id } });
  if (!row) return fail(res, 404, "NOT_FOUND", "Not found");
  if (row.status === "PAID") return fail(res, 400, "ALREADY", "Already paid");
  const updated = await prisma.merchantSettlement.update({
    where: { id },
    data: { status: "PAID" },
  });
  await audit(req.user?.id, "merchant.settlement.retry", "MerchantSettlement", id, {});
  return ok(res, serialize(updated));
});

adminMerchantsRouter.post("/merchants/settlements/:id/hold", async (req, res) => {
  const id = param(req, "id");
  const updated = await prisma.merchantSettlement.update({
    where: { id },
    data: { status: "HELD" },
  });
  await audit(req.user?.id, "merchant.settlement.hold", "MerchantSettlement", id, {});
  return ok(res, serialize(updated));
});

adminMerchantsRouter.get("/merchants/bank-changes", async (_req, res) => {
  const rows = await prisma.settlementBankChange.findMany({
    where: { status: "PENDING" },
    include: { merchant: { select: { agentId: true, businessName: true } } },
    orderBy: { requestedAt: "asc" },
  });
  return ok(res, serialize(rows));
});

adminMerchantsRouter.post("/merchants/bank-changes/:id/decide", async (req, res) => {
  const id = param(req, "id");
  const body = z.object({ status: z.enum(["APPROVED", "DENIED"]) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "status required");
  const change = await prisma.settlementBankChange.findUnique({ where: { id } });
  if (!change) return fail(res, 404, "NOT_FOUND", "Not found");

  const updated = await prisma.$transaction(async (db) => {
    const c = await db.settlementBankChange.update({
      where: { id },
      data: { status: body.data.status, decidedAt: new Date() },
    });
    if (body.data.status === "APPROVED") {
      await db.merchant.update({
        where: { id: change.merchantId },
        data: {
          settlementBank: change.newBank,
          settlementAccount: change.newAccount,
          settlementAccountName: change.newAccountName,
        },
      });
    }
    return c;
  });
  await audit(req.user?.id, "merchant.bank_change.decide", "SettlementBankChange", id, body.data);
  return ok(res, serialize(updated));
});

// ── Float adjust (dual approve) ─────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/float-adjustments", async (_req, res) => {
  const rows = await prisma.floatAdjustment.findMany({
    include: {
      merchant: { select: { agentId: true, businessName: true } },
      requestedBy: { select: { id: true, name: true, email: true } },
      approvedBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok(res, serialize(rows));
});

adminMerchantsRouter.post("/merchants/float-adjustments", async (req, res) => {
  const body = z
    .object({
      merchantId: z.string(),
      amountMinor: z.union([z.number(), z.string()]),
      reason: z.string().min(3),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid float adjustment");
  const row = await prisma.floatAdjustment.create({
    data: {
      merchantId: body.data.merchantId,
      amountMinor: toMinor(body.data.amountMinor),
      reason: body.data.reason,
      requestedById: req.user!.id,
      status: "PENDING",
    },
  });
  await audit(req.user?.id, "merchant.float_adjust.request", "FloatAdjustment", row.id, body.data);
  return ok(res, serialize(row), 201);
});

adminMerchantsRouter.post("/merchants/float-adjustments/:id/decide", async (req, res) => {
  const id = param(req, "id");
  const body = z.object({ status: z.enum(["APPROVED", "DENIED"]) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "status required");

  const adj = await prisma.floatAdjustment.findUnique({ where: { id } });
  if (!adj) return fail(res, 404, "NOT_FOUND", "Not found");
  if (adj.status !== "PENDING") return fail(res, 400, "ALREADY", "Already decided");
  if (adj.requestedById === req.user!.id) {
    return fail(res, 403, "DUAL_APPROVAL", "Second admin must approve");
  }

  const updated = await prisma.$transaction(async (db) => {
    const row = await db.floatAdjustment.update({
      where: { id },
      data: {
        status: body.data.status,
        approvedById: req.user!.id,
        decidedAt: new Date(),
      },
    });
    if (body.data.status === "APPROVED") {
      const amt = adj.amountMinor;
      if (amt >= 0n) {
        await topUpDigital(adj.merchantId, amt, db);
      } else {
        const f = await db.merchantFloat.findUnique({ where: { merchantId: adj.merchantId } });
        if (!f || f.digitalMinor < -amt) throw new Error("Insufficient digital float");
        await db.merchantFloat.update({
          where: { merchantId: adj.merchantId },
          data: { digitalMinor: { decrement: -amt } },
        });
      }
    }
    return row;
  });

  await audit(req.user?.id, "merchant.float_adjust.decide", "FloatAdjustment", id, body.data);
  return ok(res, serialize(updated));
});

// ── Fees ────────────────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/fees", async (_req, res) => {
  const rows = await prisma.merchantFeeRule.findMany({
    orderBy: [{ service: "asc" }, { minAmount: "asc" }],
  });
  return ok(res, serialize(rows));
});

adminMerchantsRouter.post("/merchants/fees", async (req, res) => {
  const body = z
    .object({
      service: z.string(),
      minAmount: z.number().int().default(0),
      maxAmount: z.number().int().nullable().optional(),
      feeType: z.enum(["percent", "flat"]),
      value: z.number().int(),
      tier: z.string().optional().nullable(),
      version: z.number().int().default(1),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid fee rule");
  const row = await prisma.merchantFeeRule.create({
    data: {
      service: body.data.service,
      minAmount: body.data.minAmount,
      maxAmount: body.data.maxAmount ?? null,
      feeType: body.data.feeType,
      value: body.data.value,
      tier: body.data.tier ?? null,
      version: body.data.version,
    },
  });
  await audit(req.user?.id, "merchant.fee.create", "MerchantFeeRule", row.id, body.data);
  return ok(res, serialize(row), 201);
});

// ── Tiers ───────────────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/tiers", async (_req, res) => {
  return ok(res, serialize(await prisma.merchantTierRule.findMany()));
});

adminMerchantsRouter.post("/merchants/tiers", async (req, res) => {
  const body = z
    .object({
      tier: z.enum(["SILVER", "GOLD", "PLATINUM"]),
      monthlyVolumeThreshold: z.union([z.number(), z.string()]),
      dailyLimitMinor: z.number().int(),
      singleLimitMinor: z.number().int(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid tier rule");
  const row = await prisma.merchantTierRule.upsert({
    where: { tier: body.data.tier },
    create: {
      tier: body.data.tier,
      monthlyVolumeThreshold: toMinor(body.data.monthlyVolumeThreshold),
      dailyLimitMinor: body.data.dailyLimitMinor,
      singleLimitMinor: body.data.singleLimitMinor,
    },
    update: {
      monthlyVolumeThreshold: toMinor(body.data.monthlyVolumeThreshold),
      dailyLimitMinor: body.data.dailyLimitMinor,
      singleLimitMinor: body.data.singleLimitMinor,
    },
  });
  await audit(req.user?.id, "merchant.tier.upsert", "MerchantTierRule", row.id, body.data);
  return ok(res, serialize(row));
});

// ── Billers CRUD ────────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/billers", async (_req, res) => {
  const rows = await prisma.biller.findMany({
    include: { plans: { orderBy: { sort: "asc" } } },
    orderBy: [{ category: "asc" }, { sort: "asc" }],
  });
  return ok(res, serialize(rows));
});

adminMerchantsRouter.post("/merchants/billers", async (req, res) => {
  const body = z
    .object({
      category: z.enum(["AIRTIME", "DATA", "POWER", "CABLE"]),
      name: z.string().min(1),
      logoUrl: z.string().optional().nullable(),
      brandColor: z.string().optional(),
      enabled: z.boolean().optional(),
      sort: z.number().int().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid biller");
  const row = await prisma.biller.create({
    data: {
      category: body.data.category,
      name: body.data.name,
      logoUrl: body.data.logoUrl ?? null,
      brandColor: body.data.brandColor ?? "#0E3B2E",
      enabled: body.data.enabled ?? true,
      sort: body.data.sort ?? 0,
    },
  });
  return ok(res, serialize(row), 201);
});

adminMerchantsRouter.patch("/merchants/billers/:id", async (req, res) => {
  const id = param(req, "id");
  const body = z
    .object({
      name: z.string().optional(),
      logoUrl: z.string().nullable().optional(),
      brandColor: z.string().optional(),
      enabled: z.boolean().optional(),
      sort: z.number().int().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid patch");
  const row = await prisma.biller.update({ where: { id }, data: body.data });
  return ok(res, serialize(row));
});

adminMerchantsRouter.post("/merchants/billers/:id/plans", async (req, res) => {
  const billerId = param(req, "id");
  const body = z
    .object({
      name: z.string().min(1),
      priceMinor: z.number().int(),
      sort: z.number().int().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid plan");
  const row = await prisma.billerPlan.create({
    data: {
      billerId,
      name: body.data.name,
      priceMinor: body.data.priceMinor,
      sort: body.data.sort ?? 0,
    },
  });
  return ok(res, serialize(row), 201);
});

// ── Directory ───────────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/directory", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  // Admin sees all listed + unlisted
  const rows = await prisma.merchant.findMany({
    where: {
      status: "ACTIVE",
      ...(q
        ? {
            OR: [
              { businessName: { contains: q } },
              { agentId: { contains: q } },
              { address: { contains: q } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      agentId: true,
      tag: true,
      businessName: true,
      address: true,
      state: true,
      lga: true,
      lat: true,
      lng: true,
      listedInDirectory: true,
      premiumPartner: true,
      openHours: true,
    },
    orderBy: { businessName: "asc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminMerchantsRouter.get("/merchants/directory/public-preview", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  return ok(res, serialize(await listAgents({ q })));
});

adminMerchantsRouter.patch("/merchants/directory/:id", async (req, res) => {
  const id = param(req, "id");
  const body = z
    .object({
      listedInDirectory: z.boolean().optional(),
      premiumPartner: z.boolean().optional(),
      lat: z.number().optional().nullable(),
      lng: z.number().optional().nullable(),
      openHours: z.any().optional(),
      address: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid patch");
  const updated = await prisma.merchant.update({ where: { id }, data: body.data });
  await audit(req.user?.id, "merchant.directory.patch", "Merchant", id, body.data);
  return ok(res, serialize(updated));
});

// ── Referrals ───────────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/referrals", async (_req, res) => {
  const rows = await prisma.merchantReferral.findMany({
    include: {
      referrer: { select: { agentId: true, businessName: true } },
      referred: { select: { agentId: true, businessName: true, status: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok(res, serialize(rows));
});

adminMerchantsRouter.post("/merchants/referrals/:id/payout", async (req, res) => {
  const id = param(req, "id");
  const row = await prisma.merchantReferral.findUnique({ where: { id } });
  if (!row) return fail(res, 404, "NOT_FOUND", "Not found");
  const updated = await prisma.$transaction(async (db) => {
    await db.merchant.update({
      where: { id: row.referrerId },
      data: { unpaidEarningsMinor: { increment: row.rewardMinor } },
    });
    return db.merchantReferral.update({
      where: { id },
      data: { status: "paid" },
    });
  });
  await audit(req.user?.id, "merchant.referral.payout", "MerchantReferral", id, {});
  return ok(res, serialize(updated));
});

// ── Broadcasts ──────────────────────────────────────────────────────────────
adminMerchantsRouter.post("/merchants/broadcasts", async (req, res) => {
  const body = z
    .object({
      title: z.string().min(1),
      body: z.string().default(""),
      href: z.string().optional().nullable(),
      tier: z.enum(["SILVER", "GOLD", "PLATINUM"]).optional(),
      state: z.string().optional(),
      status: z.enum(["ACTIVE", "PENDING", "SUSPENDED", "CLOSED"]).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid broadcast");

  const merchants = await prisma.merchant.findMany({
    where: {
      ...(body.data.tier ? { tier: body.data.tier } : {}),
      ...(body.data.state ? { state: body.data.state } : {}),
      ...(body.data.status ? { status: body.data.status } : { status: "ACTIVE" }),
    },
    select: { userId: true },
  });

  if (merchants.length) {
    await prisma.notification.createMany({
      data: merchants.map((m) => ({
        userId: m.userId,
        title: body.data.title,
        body: body.data.body,
        href: body.data.href ?? "/merchant",
      })),
    });
  }

  await audit(req.user?.id, "merchant.broadcast", "Notification", undefined, {
    count: merchants.length,
    title: body.data.title,
  });
  return ok(res, { sent: merchants.length });
});

// ── Reports ─────────────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/reports", async (req, res) => {
  const days = Number(req.query.days ?? 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const txs = await prisma.merchantTransaction.findMany({
    where: { createdAt: { gte: since }, status: "COMPLETED" },
  });

  const byService: Record<string, { count: number; volume: string; platformFee: string; agentFee: string }> =
    {};
  for (const t of txs) {
    if (!byService[t.kind]) {
      byService[t.kind] = { count: 0, volume: "0", platformFee: "0", agentFee: "0" };
    }
    const a = t.amountMinor < 0n ? -t.amountMinor : t.amountMinor;
    const s = byService[t.kind]!;
    s.count += 1;
    s.volume = String(BigInt(s.volume) + a);
    s.platformFee = String(BigInt(s.platformFee) + t.platformFeeMinor);
    s.agentFee = String(BigInt(s.agentFee) + t.agentFeeMinor);
  }

  const byState = await prisma.merchant.groupBy({
    by: ["state"],
    _count: { id: true },
    where: { status: "ACTIVE" },
  });

  return ok(
    res,
    serialize({
      days,
      byService,
      byState,
      totalTx: txs.length,
    }),
  );
});

// ── Audit ───────────────────────────────────────────────────────────────────
adminMerchantsRouter.get("/merchants/audit", async (_req, res) => {
  const rows = await prisma.auditLog.findMany({
    where: { entity: { startsWith: "Merchant" } },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { actor: { select: { id: true, name: true, email: true } } },
  });
  // Also include merchant.* actions
  const more = await prisma.auditLog.findMany({
    where: { action: { startsWith: "merchant." } },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { actor: { select: { id: true, name: true, email: true } } },
  });
  const merged = [...rows, ...more]
    .filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 100);
  return ok(res, serialize(merged));
});

// ── Detail / approve (after static /merchants/* paths) ───────────────────────
adminMerchantsRouter.get("/merchants/:id", async (req, res) => {
  const id = param(req, "id");
  const row = await prisma.merchant.findFirst({
    where: { OR: [{ id }, { agentId: id }] },
    include: {
      float: true,
      documents: true,
      staff: true,
      branches: true,
      settlements: { orderBy: { createdAt: "desc" }, take: 20 },
      user: { select: { id: true, email: true, phone: true, name: true } },
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Merchant not found");
  return ok(res, serialize(row));
});

adminMerchantsRouter.patch("/merchants/:id", async (req, res) => {
  const id = param(req, "id");
  const body = z
    .object({
      status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "CLOSED"]).optional(),
      tier: z.enum(["SILVER", "GOLD", "PLATINUM"]).optional(),
      dailyLimit: z.number().int().optional(),
      premiumPartner: z.boolean().optional(),
      listedInDirectory: z.boolean().optional(),
      reason: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid patch");

  const before = await prisma.merchant.findUnique({ where: { id } });
  if (!before) return fail(res, 404, "NOT_FOUND", "Merchant not found");

  const { reason, ...data } = body.data;
  const updated = await prisma.merchant.update({ where: { id }, data });
  await audit(req.user?.id, "merchant.patch", "Merchant", id, { before, after: updated, reason });
  return ok(res, serialize(updated));
});

adminMerchantsRouter.post("/merchants/:id/approve", async (req, res) => {
  const id = param(req, "id");
  const merchant = await prisma.merchant.findUnique({
    where: { id },
    include: { documents: true },
  });
  if (!merchant) return fail(res, 404, "NOT_FOUND", "Merchant not found");

  const tierRule = await prisma.merchantTierRule.findUnique({ where: { tier: merchant.tier } });
  const dailyLimit = tierRule?.dailyLimitMinor ?? 50_000_000;

  const updated = await prisma.merchant.update({
    where: { id },
    data: { status: "ACTIVE", dailyLimit },
  });

  await prisma.notification.create({
    data: {
      userId: merchant.userId,
      title: "Merchant approved",
      body: `Your till ${merchant.agentId} is active. Daily limit ₦${(dailyLimit / 100).toLocaleString()}.`,
      href: "/merchant",
    },
  });

  await audit(req.user?.id, "merchant.approve", "Merchant", id, { dailyLimit });
  return ok(res, serialize(updated));
});
