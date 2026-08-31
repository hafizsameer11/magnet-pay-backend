import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {fail, ok, requireAuth, serialize, param, inputJson } from "../lib/http.js";
import {
  mergeNotificationPrefs,
  parseDeviceSessions,
  serializeDeviceSessionsForClient,
  type DeviceSession,
} from "../services/notify.js";
import { mpEmail, notifyUser } from "../services/user-notify.js";
import { processKycVerification } from "../services/kyc-verify-job.js";

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
      dateOfBirth: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .nullable(),
      locale: z.string().optional(),
      onboardingDone: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid body");
  if (body.data.role === "BOTH") {
    return fail(res, 400, "VALIDATION", "Mixed buyer/seller accounts are not supported");
  }
  const { dateOfBirth, ...rest } = body.data;
  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: {
      ...rest,
      ...(dateOfBirth !== undefined
        ? { dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00.000Z`) : null }
        : {}),
    },
  });
  return ok(res, serialize(user));
});

meRouter.post("/kyc", requireAuth, async (req, res) => {
  const body = z
    .object({
      type: z.enum(["BVN", "NIN", "CN_ID", "BUSINESS"]),
      tier: z.number().int().min(1).max(3).default(1),
      payload: z.record(z.any()).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid KYC payload");

  const incoming = (body.data.payload ?? {}) as Record<string, unknown>;
  const number = String(incoming.number ?? "").replace(/\D/g, "");
  if ((body.data.type === "BVN" || body.data.type === "NIN") && number.length !== 11) {
    return fail(res, 400, "VALIDATION", `${body.data.type} must be 11 digits`);
  }

  if (body.data.type === "BVN" || body.data.type === "NIN") {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { name: true, dateOfBirth: true },
    });
    if (!user?.name?.trim()) {
      return fail(res, 400, "VALIDATION", "Add your full name on your profile before verifying identity");
    }
    if (!user.dateOfBirth) {
      return fail(res, 400, "VALIDATION", "Add your date of birth on your profile before verifying identity");
    }
  }

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
    ...(number ? { number } : {}),
    premblyStatus: "queued",
  };

  const app = open
    ? await prisma.kycApplication.update({
        where: { id: open.id },
        data: {
          type: body.data.type,
          tier: body.data.tier,
          payload: inputJson(mergedPayload),
          status: "SUBMITTED",
        },
      })
    : await prisma.kycApplication.create({
        data: {
          userId: req.user!.id,
          type: body.data.type,
          tier: body.data.tier,
          payload: inputJson(mergedPayload),
          status: "SUBMITTED",
        },
      });

  if (body.data.type === "BVN" || body.data.type === "NIN") {
    await processKycVerification(app.id);
    const fresh = await prisma.kycApplication.findUnique({ where: { id: app.id } });
    if (fresh?.status === "REJECTED") {
      const payload = (fresh.payload ?? {}) as Record<string, unknown>;
      return fail(res, 422, "KYC_REJECTED", String(payload.rejectionReason ?? "Identity verification failed"));
    }
    return ok(res, serialize(fresh ?? app), open ? 200 : 201);
  }

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
      documents: inputJson(nextDocs),
      status: "SUBMITTED",
    },
    update: {
      companyName: body.data.companyName,
      licenseNo: body.data.licenseNo ?? existing?.licenseNo,
      documents: inputJson(nextDocs),
      status: "SUBMITTED",
    },
  });

  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { role: true } });
  if (user?.role === "BUYER") {
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { role: "SELLER" },
    });
  }

  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "kyb.submitted",
      entity: "BusinessProfile",
      entityId: profile.id,
      meta: { companyName: profile.companyName },
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
  const id = String(param(req, "id"));
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
  notifyUser(req.user!.id, {
    title: "Account deletion scheduled",
    body: "Your request was received. Support will confirm within 7 days.",
    href: "/settings",
    emailPref: "emailKyc",
    emailSubject: "Account deletion scheduled",
    emailText: mpEmail(null, ["Your account deletion request was received. Support will confirm within 7 days."]),
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

meRouter.get("/devices", requireAuth, async (req, res) => {
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : undefined;
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { deviceTokens: true },
  });
  if (!user) return fail(res, 404, "NOT_FOUND", "User not found");
  const sessions = parseDeviceSessions(user.deviceTokens);
  return ok(res, serialize(serializeDeviceSessionsForClient(sessions, deviceId)));
});

meRouter.post("/devices", requireAuth, async (req, res) => {
  const body = z
    .object({
      token: z.string().min(8),
      deviceId: z.string().min(4).max(120),
      label: z.string().min(1).max(120),
      platform: z.string().min(1).max(32),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "token, deviceId, label, and platform required");

  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { deviceTokens: true },
  });
  if (!user) return fail(res, 404, "NOT_FOUND", "User not found");

  const sessions = parseDeviceSessions(user.deviceTokens);
  const now = new Date().toISOString();
  const nextSession: DeviceSession = {
    id: body.data.deviceId,
    token: body.data.token,
    label: body.data.label,
    platform: body.data.platform,
    lastSeenAt: now,
  };

  const idx = sessions.findIndex((s) => s.id === body.data.deviceId);
  if (idx >= 0) sessions[idx] = nextSession;
  else sessions.push(nextSession);

  await prisma.user.update({
    where: { id: req.user!.id },
    data: { deviceTokens: sessions as object },
  });

  return ok(
    res,
    {
      registered: true,
      sessions: serializeDeviceSessionsForClient(sessions, body.data.deviceId),
    },
    201,
  );
});

meRouter.delete("/devices/:deviceId", requireAuth, async (req, res) => {
  const deviceId = param(req, "deviceId");
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { deviceTokens: true },
  });
  if (!user) return fail(res, 404, "NOT_FOUND", "User not found");

  const sessions = parseDeviceSessions(user.deviceTokens).filter((s) => s.id !== deviceId);
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { deviceTokens: sessions as object },
  });

  return ok(res, { removed: deviceId, sessions: serializeDeviceSessionsForClient(sessions) });
});
