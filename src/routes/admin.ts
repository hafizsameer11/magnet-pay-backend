import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { fail, ok, requireAuth, requireAdmin, serialize } from "../lib/http.js";
import { z } from "zod";
import { deliverUserNotification } from "../services/deliver.js";
import { formatMoney } from "../services/ledger.js";

export const notificationsRouter = Router();
export const messagesRouter = Router();
export const adminRouter = Router();

notificationsRouter.get("/", requireAuth, async (req, res) => {
  const rows = await prisma.notification.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return ok(res, serialize(rows));
});

notificationsRouter.post("/:id/read", requireAuth, async (req, res) => {
  const row = await prisma.notification.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Not found");
  const updated = await prisma.notification.update({
    where: { id: row.id },
    data: { read: true },
  });
  return ok(res, serialize(updated));
});

messagesRouter.get("/conversations", requireAuth, async (req, res) => {
  const parts = await prisma.conversationParticipant.findMany({
    where: { userId: req.user!.id },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
          participants: { include: { user: { select: { id: true, name: true, phone: true } } } },
        },
      },
    },
  });
  return ok(res, serialize(parts.map((p) => p.conversation)));
});

messagesRouter.post("/conversations", requireAuth, async (req, res) => {
  const body = z
    .object({ peerUserId: z.string().uuid(), subject: z.string().optional(), body: z.string().optional() })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "peerUserId required");
  const conv = await prisma.$transaction(async (tx) => {
    const c = await tx.conversation.create({
      data: {
        subject: body.data.subject,
        participants: {
          create: [{ userId: req.user!.id }, { userId: body.data.peerUserId }],
        },
      },
    });
    if (body.data.body) {
      await tx.message.create({
        data: { conversationId: c.id, senderId: req.user!.id, body: body.data.body },
      });
    }
    return tx.conversation.findUnique({
      where: { id: c.id },
      include: { messages: true, participants: true },
    });
  });
  return ok(res, serialize(conv), 201);
});

messagesRouter.get("/conversations/:id/messages", requireAuth, async (req, res) => {
  const part = await prisma.conversationParticipant.findFirst({
    where: { conversationId: req.params.id, userId: req.user!.id },
  });
  if (!part) return fail(res, 403, "FORBIDDEN", "Not a participant");
  const messages = await prisma.message.findMany({
    where: { conversationId: req.params.id },
    orderBy: { createdAt: "asc" },
  });
  return ok(res, serialize(messages));
});

messagesRouter.post("/conversations/:id/messages", requireAuth, async (req, res) => {
  const body = z
    .object({
      body: z.string().optional().default(""),
      attachmentUrl: z.string().min(1).optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid message");
  const text = (body.data.body ?? "").trim();
  const attachmentUrl = body.data.attachmentUrl || null;
  if (!text && !attachmentUrl) return fail(res, 400, "VALIDATION", "body or attachment required");
  const part = await prisma.conversationParticipant.findFirst({
    where: { conversationId: req.params.id, userId: req.user!.id },
  });
  if (!part) return fail(res, 403, "FORBIDDEN", "Not a participant");
  const msg = await prisma.message.create({
    data: {
      conversationId: req.params.id,
      senderId: req.user!.id,
      body: text || (attachmentUrl ? "Attachment" : ""),
      attachmentUrl,
    },
  });
  await prisma.conversation.update({
    where: { id: req.params.id },
    data: { updatedAt: new Date() },
  });
  return ok(res, serialize(msg), 201);
});

messagesRouter.post("/support", requireAuth, async (req, res) => {
  const body = z
    .object({ topic: z.string().min(2), message: z.string().min(1) })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "topic and message required");
  const admin = await prisma.user.findFirst({
    where: {
      OR: [
        { platformRole: "ADMIN" },
        { platformRole: "SUPER_ADMIN" },
        { phone: "+2348000000001" },
      ],
    },
    select: { id: true },
  });
  if (!admin) return fail(res, 503, "NO_ADMIN", "Support unavailable");
  const existing = await prisma.conversationParticipant.findFirst({
    where: {
      userId: req.user!.id,
      conversation: { subject: { contains: "Support" } },
    },
    include: { conversation: true },
  });
  if (existing) {
    const msg = await prisma.message.create({
      data: {
        conversationId: existing.conversationId,
        senderId: req.user!.id,
        body: `[${body.data.topic}] ${body.data.message}`,
      },
    });
    return ok(res, serialize({ conversationId: existing.conversationId, message: msg }));
  }
  const conv = await prisma.$transaction(async (tx) => {
    const c = await tx.conversation.create({
      data: {
        subject: `Support · ${body.data.topic}`,
        participants: {
          create: [{ userId: req.user!.id }, { userId: admin.id }],
        },
      },
    });
    const msg = await tx.message.create({
      data: {
        conversationId: c.id,
        senderId: req.user!.id,
        body: body.data.message,
      },
    });
    return { conversationId: c.id, message: msg };
  });
  return ok(res, serialize(conv), 201);
});

adminRouter.use(requireAdmin);

adminRouter.post("/users/invite", async (req, res) => {
  const body = z
    .object({ phone: z.string().min(8), role: z.enum(["BUYER", "SELLER", "BOTH"]).default("BUYER") })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "phone required");
  const existing = await prisma.user.findFirst({ where: { phone: body.data.phone } });
  if (existing) return ok(res, { invited: false, reason: "already_registered", userId: existing.id });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "admin.invite",
      entity: "user",
      entityId: body.data.phone,
      meta: { role: body.data.role },
    },
  });
  return ok(res, { invited: true, phone: body.data.phone, role: body.data.role }, 201);
});

adminRouter.get("/users", async (_req, res) => {
  const users = await prisma.user.findMany({
    take: 100,
    orderBy: { createdAt: "desc" },
    include: { wallets: true, kycApplications: { take: 1, orderBy: { createdAt: "desc" } } },
  });
  return ok(res, serialize(users));
});

adminRouter.get("/kyc", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const where =
    status && ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"].includes(status)
      ? { status: status as "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" }
      : undefined;
  const rows = await prisma.kycApplication.findMany({
    where,
    include: { user: { select: { id: true, name: true, phone: true, email: true } } },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(rows));
});

adminRouter.get("/kyc/:id", async (req, res) => {
  const app = await prisma.kycApplication.findUnique({
    where: { id: req.params.id },
    include: { user: { select: { id: true, name: true, phone: true, email: true } } },
  });
  if (!app) return fail(res, 404, "NOT_FOUND", "KYC application not found");
  return ok(res, serialize(app));
});

adminRouter.post("/kyc/:id/decide", async (req, res) => {
  const body = z
    .object({
      status: z.enum(["APPROVED", "REJECTED"]),
      note: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "status required");
  const existing = await prisma.kycApplication.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "KYC application not found");

  const prevPayload = (existing.payload as Record<string, unknown> | null) ?? {};
  const app = await prisma.kycApplication.update({
    where: { id: req.params.id },
    data: {
      status: body.data.status,
      payload: (body.data.note ? { ...prevPayload, adminNote: body.data.note } : prevPayload) as object,
    },
    include: { user: { select: { id: true, name: true, phone: true, email: true } } },
  });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: `kyc.${body.data.status.toLowerCase()}`,
      entity: "KycApplication",
      entityId: app.id,
      meta: body.data.note ? { note: body.data.note } : undefined,
    },
  });
  const user = await prisma.user.findUnique({
    where: { id: app.userId },
    select: { id: true, email: true, name: true, notificationPrefs: true, deviceTokens: true },
  });
  const verdict = body.data.status === "APPROVED" ? "approved" : "rejected";
  void deliverUserNotification(app.userId, {
    title: `KYC ${verdict}`,
    body: body.data.note ? body.data.note : `Your KYC application was ${verdict}.`,
    href: "/kyc-status",
    email: {
      prefKey: "emailKyc",
      subject: `KYC ${verdict}`,
      text: `Hi ${user?.name || "there"},\n\nYour MagnetPay KYC application was ${verdict}.${
        body.data.note ? `\n\nNote: ${body.data.note}` : ""
      }\n\n— MagnetPay`,
    },
  });
  return ok(res, serialize(app));
});

adminRouter.get("/kyb", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const where =
    status && ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"].includes(status)
      ? { status: status as "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" }
      : undefined;
  const rows = await prisma.businessProfile.findMany({
    where,
    include: { user: { select: { id: true, name: true, phone: true, email: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return ok(res, serialize(rows));
});

adminRouter.get("/kyb/:id", async (req, res) => {
  const profile = await prisma.businessProfile.findUnique({
    where: { id: req.params.id },
    include: { user: { select: { id: true, name: true, phone: true, email: true } } },
  });
  if (!profile) return fail(res, 404, "NOT_FOUND", "KYB profile not found");
  return ok(res, serialize(profile));
});

adminRouter.post("/kyb/:id/decide", async (req, res) => {
  const body = z
    .object({
      status: z.enum(["APPROVED", "REJECTED"]),
      note: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "status required");
  const existing = await prisma.businessProfile.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "KYB profile not found");

  const prevDocs = (existing.documents as Record<string, unknown> | null) ?? {};
  const profile = await prisma.businessProfile.update({
    where: { id: req.params.id },
    data: {
      status: body.data.status,
      documents: (body.data.note ? { ...prevDocs, adminNote: body.data.note } : prevDocs) as object,
    },
    include: { user: { select: { id: true, name: true, phone: true, email: true } } },
  });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: `kyb.${body.data.status.toLowerCase()}`,
      entity: "BusinessProfile",
      entityId: profile.id,
      meta: body.data.note ? { note: body.data.note } : undefined,
    },
  });
  const user = await prisma.user.findUnique({
    where: { id: profile.userId },
    select: { id: true, email: true, name: true, notificationPrefs: true, deviceTokens: true },
  });
  const verdict = body.data.status === "APPROVED" ? "approved" : "rejected";
  void deliverUserNotification(profile.userId, {
    title: `Business verification ${verdict}`,
    body: body.data.note ? body.data.note : `Your KYB verification was ${verdict}.`,
    href: "/kyc-status",
    email: {
      prefKey: "emailKyc",
      subject: `Business verification ${verdict}`,
      text: `Hi ${user?.name || "there"},\n\nYour MagnetPay business (KYB) verification was ${verdict}.${
        body.data.note ? `\n\nNote: ${body.data.note}` : ""
      }\n\n— MagnetPay`,
    },
  });
  return ok(res, serialize(profile));
});

adminRouter.get("/wallets", async (_req, res) => {
  const wallets = await prisma.wallet.findMany({
    include: { user: { select: { id: true, name: true, phone: true } } },
    take: 200,
  });
  return ok(res, serialize(wallets));
});

adminRouter.get("/transfers", async (_req, res) => {
  const rows = await prisma.transfer.findMany({
    include: { recipient: true, sender: { select: { id: true, name: true, phone: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok(res, serialize(rows));
});

adminRouter.get("/export/transfers.csv", async (_req, res) => {
  const rows = await prisma.transfer.findMany({
    include: { recipient: true, sender: { select: { id: true, name: true, phone: true } } },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = [
    "id",
    "createdAt",
    "status",
    "currency",
    "amountMinor",
    "senderId",
    "senderName",
    "senderPhone",
    "recipientId",
    "recipientName",
    "recipientAccount",
    "note",
    "nombaRef",
  ].join(",");
  const lines = rows.map((t) =>
    [
      t.id,
      t.createdAt.toISOString(),
      t.status,
      t.currency,
      t.amountMinor.toString(),
      t.senderId,
      escape(t.sender.name || ""),
      escape(t.sender.phone || ""),
      t.recipientId,
      escape(t.recipient.name || ""),
      escape(t.recipient.accountHint || ""),
      escape(t.note || ""),
      escape(t.nombaRef || ""),
    ].join(","),
  );
  const csv = [header, ...lines].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="transfers.csv"');
  return res.status(200).send(csv);
});

adminRouter.get("/escrows", async (_req, res) => {
  const rows = await prisma.escrow.findMany({
    include: { milestones: true, disputes: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok(res, serialize(rows));
});

adminRouter.post("/escrows/:id/resolve", async (req, res) => {
  const body = z.object({ outcome: z.string().min(3) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "outcome required");
  const escrow = await prisma.escrow.update({
    where: { id: req.params.id },
    data: { status: "RESOLVED" },
  });
  await prisma.dispute.updateMany({
    where: { escrowId: escrow.id, outcome: null },
    data: { outcome: body.data.outcome },
  });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "escrow.resolve",
      entity: "Escrow",
      entityId: escrow.id,
      meta: { outcome: body.data.outcome },
    },
  });
  return ok(res, serialize(escrow));
});

adminRouter.get("/shipments", async (_req, res) => {
  const rows = await prisma.shipment.findMany({
    include: { hold: true, settlement: true, user: { select: { id: true, name: true, phone: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok(res, serialize(rows));
});

adminRouter.get("/audit", async (_req, res) => {
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  return ok(res, serialize(rows));
});

adminRouter.get("/fees", async (_req, res) => {
  const rows = await prisma.feeConfig.findMany();
  return ok(res, serialize(rows));
});

// --- NEW admin endpoints ---

const userSelect = { id: true, name: true, phone: true, email: true } as const;

adminRouter.get("/users/:id", async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: {
      wallets: true,
      kycApplications: { orderBy: { createdAt: "desc" } },
      businessProfile: true,
    },
  });
  if (!user) return fail(res, 404, "NOT_FOUND", "User not found");
  return ok(res, serialize(user));
});

adminRouter.patch("/users/:id", async (req, res) => {
  const body = z
    .object({
      name: z.string().min(1).optional(),
      role: z.enum(["BUYER", "SELLER", "BOTH"]).optional(),
      platformRole: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]).optional(),
      suspended: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid body");

  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "User not found");

  const data: { name?: string; role?: "BUYER" | "SELLER" | "BOTH"; platformRole?: "USER" | "ADMIN" | "SUPER_ADMIN" } =
    {};
  if (body.data.name !== undefined) data.name = body.data.name;
  if (body.data.role !== undefined) data.role = body.data.role;
  if (body.data.platformRole !== undefined) data.platformRole = body.data.platformRole;

  const user =
    Object.keys(data).length > 0
      ? await prisma.user.update({ where: { id: req.params.id }, data })
      : existing;

  if (body.data.suspended !== undefined) {
    // User has no suspendedAt field — record via audit only
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: body.data.suspended ? "user.suspend" : "user.unsuspend",
        entity: "User",
        entityId: user.id,
        meta: { suspended: body.data.suspended, note: "No User.suspended field; audit-only" },
      },
    });
  } else if (Object.keys(data).length > 0) {
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: "user.update",
        entity: "User",
        entityId: user.id,
        meta: data,
      },
    });
  }

  return ok(
    res,
    serialize({
      ...user,
      suspended: body.data.suspended ?? undefined,
      _meta: body.data.suspended !== undefined ? { suspendViaAudit: true } : undefined,
    }),
  );
});

adminRouter.get("/deposits", async (_req, res) => {
  const rows = await prisma.deposit.findMany({
    include: { user: { select: userSelect } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminRouter.get("/deposits/:id", async (req, res) => {
  const row = await prisma.deposit.findUnique({
    where: { id: req.params.id },
    include: { user: { select: userSelect } },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Deposit not found");
  return ok(res, serialize(row));
});

adminRouter.get("/withdrawals", async (_req, res) => {
  const rows = await prisma.withdrawal.findMany({
    include: { user: { select: userSelect } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminRouter.post("/withdrawals/:id/decide", async (req, res) => {
  const body = z.object({ status: z.enum(["APPROVED", "REJECTED"]) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "status required");

  const existing = await prisma.withdrawal.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Withdrawal not found");

  // WithdrawalStatus: PENDING | PROCESSING | SUCCEEDED | FAILED
  const mapped = body.data.status === "APPROVED" ? ("SUCCEEDED" as const) : ("FAILED" as const);
  const row = await prisma.withdrawal.update({
    where: { id: req.params.id },
    data: { status: mapped },
    include: { user: { select: userSelect } },
  });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: `withdrawal.${body.data.status.toLowerCase()}`,
      entity: "Withdrawal",
      entityId: row.id,
      meta: { requested: body.data.status, stored: mapped },
    },
  });
  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { id: true, email: true, name: true, notificationPrefs: true, deviceTokens: true },
  });
  const amount = formatMoney(row.currency, row.amountMinor);
  const verdict = mapped === "SUCCEEDED" ? "approved" : "rejected";
  void deliverUserNotification(row.userId, {
    title: `Withdrawal ${verdict}`,
    body: `Your withdrawal of ${amount} was ${verdict}.`,
    href: "/notifications",
    email: {
      prefKey: "emailTransfers",
      subject: `Withdrawal ${verdict}`,
      text: `Hi ${user?.name || "there"},\n\nYour withdrawal of ${amount} was ${verdict}.\n\n— MagnetPay`,
    },
  });
  return ok(res, serialize(row));
});

adminRouter.get("/recipients", async (_req, res) => {
  const rows = await prisma.recipient.findMany({
    include: { user: { select: userSelect } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminRouter.get("/ledger", async (_req, res) => {
  const rows = await prisma.transaction.findMany({
    include: { user: { select: userSelect } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminRouter.get("/orders", async (_req, res) => {
  const rows = await prisma.marketOrder.findMany({
    include: {
      items: true,
      user: { select: userSelect },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminRouter.get("/orders/:id", async (req, res) => {
  const row = await prisma.marketOrder.findUnique({
    where: { id: req.params.id },
    include: {
      items: { include: { product: true } },
      user: { select: userSelect },
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Order not found");
  return ok(res, serialize(row));
});

adminRouter.post("/orders/:id/cancel", async (req, res) => {
  const existing = await prisma.marketOrder.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Order not found");

  const row = await prisma.marketOrder.update({
    where: { id: req.params.id },
    data: { status: "CANCELLED" },
    include: { items: true, user: { select: userSelect } },
  });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "order.cancel",
      entity: "MarketOrder",
      entityId: row.id,
      meta: { previousStatus: existing.status },
    },
  });
  return ok(res, serialize(row));
});

adminRouter.get("/products", async (_req, res) => {
  const rows = await prisma.product.findMany({
    include: {
      store: { include: { user: { select: userSelect } } },
      category: true,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminRouter.post("/products/:id/moderate", async (req, res) => {
  const body = z
    .object({
      status: z.enum(["APPROVED", "HIDDEN", "REJECTED"]).optional(),
      active: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "status or active required");
  if (body.data.status === undefined && body.data.active === undefined) {
    return fail(res, 400, "VALIDATION", "status or active required");
  }

  const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Product not found");

  // Product has `active` boolean only — map moderation statuses
  let active = existing.active;
  if (body.data.active !== undefined) active = body.data.active;
  else if (body.data.status === "APPROVED") active = true;
  else if (body.data.status === "HIDDEN" || body.data.status === "REJECTED") active = false;

  const row = await prisma.product.update({
    where: { id: req.params.id },
    data: { active },
    include: { store: true, category: true },
  });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "product.moderate",
      entity: "Product",
      entityId: row.id,
      meta: { status: body.data.status, active },
    },
  });
  return ok(res, serialize(row));
});

adminRouter.get("/categories", async (_req, res) => {
  const rows = await prisma.category.findMany({
    include: { _count: { select: { products: true } } },
    orderBy: { name: "asc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminRouter.post("/categories", async (req, res) => {
  const body = z
    .object({
      slug: z.string().min(1),
      name: z.string().min(1),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "slug and name required");

  const existing = await prisma.category.findUnique({ where: { slug: body.data.slug } });
  if (existing) return fail(res, 409, "CONFLICT", "Category slug already exists");

  const row = await prisma.category.create({ data: body.data });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "category.create",
      entity: "Category",
      entityId: row.id,
      meta: body.data,
    },
  });
  return ok(res, serialize(row), 201);
});

adminRouter.patch("/categories/:id", async (req, res) => {
  const body = z
    .object({
      slug: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid body");

  const existing = await prisma.category.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Category not found");

  const row = await prisma.category.update({
    where: { id: req.params.id },
    data: {
      ...(body.data.slug !== undefined ? { slug: body.data.slug } : {}),
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "category.update",
      entity: "Category",
      entityId: row.id,
      meta: body.data,
    },
  });
  return ok(res, serialize(row));
});

adminRouter.get("/sellers", async (_req, res) => {
  const rows = await prisma.sellerStore.findMany({
    include: { user: { select: userSelect }, _count: { select: { products: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminRouter.get("/reviews", async (_req, res) => {
  const rows = await prisma.review.findMany({
    include: {
      user: { select: userSelect },
      product: { select: { id: true, title: true, storeId: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminRouter.get("/escrows/:id", async (req, res) => {
  const row = await prisma.escrow.findUnique({
    where: { id: req.params.id },
    include: {
      milestones: { orderBy: { sortOrder: "asc" } },
      disputes: { include: { openedBy: { select: userSelect } } },
      documents: true,
      buyer: { select: userSelect },
      seller: { select: userSelect },
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Escrow not found");
  return ok(res, serialize(row));
});

adminRouter.get("/disputes", async (_req, res) => {
  const rows = await prisma.dispute.findMany({
    include: {
      escrow: true,
      openedBy: { select: userSelect },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminRouter.get("/shipments/:id", async (req, res) => {
  const row = await prisma.shipment.findUnique({
    where: { id: req.params.id },
    include: {
      user: { select: userSelect },
      hold: true,
      settlement: true,
      events: { orderBy: { createdAt: "asc" } },
      documents: true,
      quote: true,
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Shipment not found");
  return ok(res, serialize(row));
});

adminRouter.get("/fx/rates", async (_req, res) => {
  const rows = await prisma.feeConfig.findMany({
    where: { key: { startsWith: "fx." } },
    orderBy: { key: "asc" },
  });
  return ok(res, serialize(rows));
});

adminRouter.put("/fx/rates", async (req, res) => {
  const body = z
    .object({
      rates: z
        .array(
          z.object({
            key: z.string().min(1),
            valueMinor: z.number().int().optional(),
            value: z.number().int().optional(),
          }),
        )
        .min(1),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "rates array required");

  const updated = [];
  for (const rate of body.data.rates) {
    const value = rate.valueMinor ?? rate.value;
    if (value === undefined) continue;
    const key = rate.key.startsWith("fx.") ? rate.key : `fx.${rate.key}`;
    const row = await prisma.feeConfig.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    updated.push(row);
  }

  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "fx.rates.update",
      entity: "FeeConfig",
      meta: { count: updated.length, keys: updated.map((r) => r.key) },
    },
  });
  return ok(res, serialize(updated));
});

adminRouter.get("/fx/conversions", async (_req, res) => {
  const rows = await prisma.fxConversion.findMany({
    include: { user: { select: userSelect } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

// No Announcement model — store/list via AuditLog action "announcement"
adminRouter.get("/announcements", async (_req, res) => {
  const rows = await prisma.auditLog.findMany({
    where: { action: "announcement" },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return ok(
    res,
    serialize(
      rows.map((r) => ({
        id: r.id,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        meta: r.meta,
        createdAt: r.createdAt,
        actorId: r.actorId,
      })),
    ),
  );
});

adminRouter.post("/announcements", async (req, res) => {
  const body = z
    .object({
      title: z.string().min(1),
      body: z.string().optional(),
      audience: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "title required");

  const row = await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "announcement",
      entity: "Announcement",
      meta: {
        title: body.data.title,
        body: body.data.body ?? "",
        audience: body.data.audience ?? "all",
      },
    },
  });
  return ok(res, serialize(row), 201);
});

adminRouter.get("/analytics/overview", async (_req, res) => {
  const [users, walletAgg, transfers, escrows, orders, shipments] = await Promise.all([
    prisma.user.count(),
    prisma.wallet.aggregate({ _sum: { balanceMinor: true, holdMinor: true } }),
    prisma.transfer.count(),
    prisma.escrow.count(),
    prisma.marketOrder.count(),
    prisma.shipment.count(),
  ]);

  return ok(
    res,
    serialize({
      users,
      wallets: {
        balanceMinorSum: walletAgg._sum.balanceMinor ?? 0n,
        holdMinorSum: walletAgg._sum.holdMinor ?? 0n,
      },
      transfers,
      escrows,
      orders,
      shipments,
    }),
  );
});

adminRouter.post("/push/test", requireAdmin, async (req, res) => {
  await deliverUserNotification(req.user!.id, {
    title: "MagnetPay test push",
    body: "If you see this, Expo FCM + backend push are working.",
    href: "/notifications",
  });
  return ok(res, { sent: true });
});

adminRouter.get("/health", async (_req, res) => {
  return ok(res, { ok: true, time: new Date().toISOString() });
});

adminRouter.get("/conversations", async (_req, res) => {
  const rows = await prisma.conversation.findMany({
    include: {
      participants: { include: { user: { select: { id: true, name: true, phone: true } } } },
      messages: { take: 1, orderBy: { createdAt: "desc" } },
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return ok(res, serialize(rows));
});

adminRouter.put("/fees", async (req, res) => {
  const body = z
    .object({
      fees: z
        .array(
          z.object({
            key: z.string().min(1),
            value: z.number().int(),
          }),
        )
        .min(1)
        .optional(),
      key: z.string().min(1).optional(),
      value: z.number().int().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "fees array or key/value required");

  const items =
    body.data.fees ??
    (body.data.key !== undefined && body.data.value !== undefined
      ? [{ key: body.data.key, value: body.data.value }]
      : null);
  if (!items) return fail(res, 400, "VALIDATION", "fees array or key/value required");

  const updated = [];
  for (const item of items) {
    const row = await prisma.feeConfig.upsert({
      where: { key: item.key },
      create: { key: item.key, value: item.value },
      update: { value: item.value },
    });
    updated.push(row);
  }

  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "fees.update",
      entity: "FeeConfig",
      meta: { keys: updated.map((r) => r.key) },
    },
  });
  return ok(res, serialize(updated));
});

adminRouter.put("/fees/:id", async (req, res) => {
  const body = z
    .object({
      key: z.string().min(1).optional(),
      value: z.number().int(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "value required");

  const byId = await prisma.feeConfig.findUnique({ where: { id: req.params.id } });
  if (byId) {
    const row = await prisma.feeConfig.update({
      where: { id: req.params.id },
      data: {
        value: body.data.value,
        ...(body.data.key !== undefined ? { key: body.data.key } : {}),
      },
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: "fees.update",
        entity: "FeeConfig",
        entityId: row.id,
        meta: { key: row.key, value: row.value },
      },
    });
    return ok(res, serialize(row));
  }

  // Treat :id as key for upsert convenience
  const key = body.data.key ?? req.params.id;
  const row = await prisma.feeConfig.upsert({
    where: { key },
    create: { key, value: body.data.value },
    update: { value: body.data.value },
  });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "fees.upsert",
      entity: "FeeConfig",
      entityId: row.id,
      meta: { key: row.key, value: row.value },
    },
  });
  return ok(res, serialize(row));
});
