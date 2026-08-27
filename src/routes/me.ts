import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { fail, ok, requireAuth, serialize } from "../lib/http.js";
import {
  mergeNotificationPrefs,
  parseDeviceTokens,
} from "../services/notify.js";

export const meRouter = Router();

meRouter.get("/", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: {
      kycApplications: { orderBy: { createdAt: "desc" }, take: 1 },
      businessProfile: true,
    },
  });
  if (!user) return fail(res, 404, "NOT_FOUND", "User not found");
  return ok(res, serialize(user));
});

meRouter.patch("/", requireAuth, async (req, res) => {
  const body = z
    .object({
      name: z.string().optional(),
      email: z.string().email().optional().nullable(),
      role: z.enum(["BUYER", "SELLER", "BOTH"]).optional(),
      avatarUrl: z.string().url().optional().nullable(),
      locale: z.string().optional(),
      onboardingDone: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid body");
  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: body.data,
  });
  return ok(res, serialize(user));
});

meRouter.post("/kyc", requireAuth, async (req, res) => {
  const body = z
    .object({
      type: z.enum(["BVN", "NIN", "CN_ID", "BUSINESS"]),
      tier: z.number().int().min(1).max(3).default(2),
      payload: z.record(z.any()).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid KYC payload");

  const incoming = (body.data.payload ?? {}) as Record<string, unknown>;
  const open = await prisma.kycApplication.findFirst({
    where: {
      userId: req.user!.id,
      status: { in: ["DRAFT", "SUBMITTED", "REJECTED"] },
    },
    orderBy: { createdAt: "desc" },
  });

  const mergedPayload = {
    ...((open?.payload as Record<string, unknown> | null) ?? {}),
    ...incoming,
  };

  const app = open
    ? await prisma.kycApplication.update({
        where: { id: open.id },
        data: {
          type: body.data.type,
          tier: body.data.tier,
          payload: mergedPayload,
          status: "SUBMITTED",
        },
      })
    : await prisma.kycApplication.create({
        data: {
          userId: req.user!.id,
          type: body.data.type,
          tier: body.data.tier,
          payload: mergedPayload,
          status: "SUBMITTED",
        },
      });

  return ok(res, serialize(app), open ? 200 : 201);
});

meRouter.get("/kyc/status", requireAuth, async (req, res) => {
  const latest = await prisma.kycApplication.findFirst({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(latest ?? { status: "DRAFT" }));
});

meRouter.post("/kyb", requireAuth, async (req, res) => {
  const body = z
    .object({
      companyName: z.string().min(2),
      licenseNo: z.string().optional(),
      documents: z.any().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid KYB");

  const existing = await prisma.businessProfile.findUnique({ where: { userId: req.user!.id } });
  const prevDocs = (existing?.documents as Record<string, unknown> | null) ?? {};
  const nextDocs =
    body.data.documents && typeof body.data.documents === "object"
      ? { ...prevDocs, ...(body.data.documents as Record<string, unknown>) }
      : prevDocs;

  const profile = await prisma.businessProfile.upsert({
    where: { userId: req.user!.id },
    create: {
      userId: req.user!.id,
      companyName: body.data.companyName,
      licenseNo: body.data.licenseNo,
      documents: nextDocs,
      status: "SUBMITTED",
    },
    update: {
      companyName: body.data.companyName,
      licenseNo: body.data.licenseNo ?? existing?.licenseNo,
      documents: nextDocs,
      status: "SUBMITTED",
    },
  });
  return ok(res, serialize(profile));
});

meRouter.get("/kyb/status", requireAuth, async (req, res) => {
  const profile = await prisma.businessProfile.findUnique({ where: { userId: req.user!.id } });
  return ok(res, serialize(profile ?? { status: "DRAFT" }));
});

meRouter.get("/addresses", requireAuth, async (req, res) => {
  const rows = await prisma.address.findMany({
    where: { userId: req.user!.id },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
  return ok(res, serialize(rows));
});

meRouter.post("/addresses", requireAuth, async (req, res) => {
  const body = z
    .object({
      label: z.string().min(1).default("Home"),
      line1: z.string().min(3),
      line2: z.string().optional().nullish(),
      city: z.string().min(2),
      state: z.string().optional().nullish(),
      country: z.string().min(2),
      postal: z.string().optional().nullish(),
      isDefault: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid address");
  const row = await prisma.$transaction(async (tx) => {
    if (body.data.isDefault) {
      await tx.address.updateMany({ where: { userId: req.user!.id }, data: { isDefault: false } });
    }
    return tx.address.create({
      data: { userId: req.user!.id, ...body.data, isDefault: body.data.isDefault ?? false },
    });
  });
  return ok(res, serialize(row), 201);
});

meRouter.delete("/addresses/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const existing = await prisma.address.findFirst({ where: { id, userId: req.user!.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Address not found");
  await prisma.address.delete({ where: { id } });
  return ok(res, { deleted: true });
});

meRouter.get("/bank-accounts", requireAuth, async (req, res) => {
  const rows = await prisma.bankAccount.findMany({
    where: { userId: req.user!.id },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
  return ok(res, serialize(rows));
});

meRouter.post("/bank-accounts", requireAuth, async (req, res) => {
  const body = z
    .object({
      rail: z.enum(["BANK", "WECHAT", "ALIPAY"]).default("BANK"),
      currency: z.enum(["NGN", "CNY", "USD"]).default("NGN"),
      bankName: z.string().optional(),
      accountName: z.string().min(2),
      accountNo: z.string().min(4),
      country: z.string().min(2),
      isDefault: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid bank account");
  const row = await prisma.$transaction(async (tx) => {
    if (body.data.isDefault) {
      await tx.bankAccount.updateMany({ where: { userId: req.user!.id }, data: { isDefault: false } });
    }
    return tx.bankAccount.create({
      data: { userId: req.user!.id, ...body.data, isDefault: body.data.isDefault ?? true },
    });
  });
  return ok(res, serialize(row), 201);
});

meRouter.post("/export", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: {
      wallets: true,
      addresses: true,
      bankAccounts: true,
      kycApplications: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!user) return fail(res, 404, "NOT_FOUND", "User not found");
  return ok(res, serialize(user));
});

meRouter.delete("/", requireAuth, async (req, res) => {
  const body = z.object({ confirm: z.literal("DELETE") }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", 'Send { "confirm": "DELETE" }');
  await prisma.notification.create({
    data: {
      userId: req.user!.id,
      title: "Account deletion scheduled",
      body: "Your request was received. Support will confirm within 7 days.",
    },
  });
  return ok(res, { scheduled: true });
});

meRouter.get("/notification-prefs", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { notificationPrefs: true },
  });
  if (!user) return fail(res, 404, "NOT_FOUND", "User not found");
  return ok(res, mergeNotificationPrefs(user.notificationPrefs));
});

meRouter.patch("/notification-prefs", requireAuth, async (req, res) => {
  const body = z
    .object({
      emailTransfers: z.boolean().optional(),
      emailEscrow: z.boolean().optional(),
      emailShipments: z.boolean().optional(),
      emailKyc: z.boolean().optional(),
      pushEnabled: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid notification prefs");

  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { notificationPrefs: true },
  });
  if (!user) return fail(res, 404, "NOT_FOUND", "User not found");

  const merged = {
    ...mergeNotificationPrefs(user.notificationPrefs),
    ...body.data,
  };

  await prisma.user.update({
    where: { id: req.user!.id },
    data: { notificationPrefs: merged as object },
  });
  return ok(res, merged);
});

meRouter.post("/devices", requireAuth, async (req, res) => {
  const body = z.object({ token: z.string().min(8) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "token required");

  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { deviceTokens: true },
  });
  if (!user) return fail(res, 404, "NOT_FOUND", "User not found");

  const tokens = parseDeviceTokens(user.deviceTokens);
  if (!tokens.includes(body.data.token)) tokens.push(body.data.token);

  await prisma.user.update({
    where: { id: req.user!.id },
    data: { deviceTokens: tokens as object },
  });
  return ok(res, { tokens, registered: true }, 201);
});
