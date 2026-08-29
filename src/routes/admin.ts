import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { fail, ok, requireAuth, requireAdmin, serialize } from "../lib/http.js";
import { z } from "zod";
import { deliverUserNotification } from "../services/deliver.js";
import { formatMoney } from "../services/ledger.js";
import { getConversationContext, upsertChatQuote } from "../services/chat-quote.js";
import {
  getFreightPricing,
  estimateFreightMinor,
  estimateQuoteFromParcelType,
  getLogisticsEstimateConfig,
  listActiveParcelTypes,
  DEFAULT_FREIGHT_PRICING,
  DEFAULT_ESTIMATE_DISCLAIMER,
} from "../services/freight-pricing.js";
import {
  getComplianceLimits,
  updateComplianceLimits,
} from "../services/compliance-limits.js";
import {
  advanceShipmentOps,
  settleShipmentOps,
  attachShipmentDocument,
  removeShipmentDocument,
  SHIPMENT_DOCUMENT_KINDS,
  SHIPMENT_NEXT,
} from "../services/shipment-ops.js";
import {
  listAdminRecords,
  getAdminRecord,
  createAdminRecord,
  patchAdminRecord,
} from "../services/admin-records.js";
import { seedAdminRecords } from "../services/admin-records-seed.js";
import { registerAdminExtensions } from "./admin-extensions.js";

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

async function peerMetaForUser(peerUserId: string, conversationId: string) {
  const [store, lastPeerMsg] = await Promise.all([
    prisma.sellerStore.findUnique({
      where: { userId: peerUserId },
      include: { products: { select: { rating: true }, take: 50 } },
    }),
    prisma.message.findFirst({
      where: { conversationId, senderId: peerUserId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  const ratings = store?.products.map((p) => p.rating) ?? [];
  const rating =
    ratings.length > 0 ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;
  return {
    storeVerified: store?.verified ?? false,
    rating,
    lastActiveAt: lastPeerMsg?.createdAt?.toISOString() ?? null,
  };
}

messagesRouter.get("/conversations", requireAuth, async (req, res) => {
  const showArchived = req.query.archived === "1";
  const parts = await prisma.conversationParticipant.findMany({
    where: {
      userId: req.user!.id,
      hiddenAt: null,
      ...(showArchived ? {} : { archivedAt: null }),
    },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
          participants: { include: { user: { select: { id: true, name: true, phone: true } } } },
        },
      },
    },
    orderBy: [{ pinnedAt: "desc" }, { conversation: { updatedAt: "desc" } }],
  });
  const rows = await Promise.all(
    parts.map(async (p) => {
      const peer = p.conversation.participants.find((x) => x.user.id !== req.user!.id)?.user;
      const peerMeta = peer ? await peerMetaForUser(peer.id, p.conversation.id) : null;
      return {
        ...p.conversation,
        myPrefs: {
          pinned: Boolean(p.pinnedAt),
          muted: p.muted,
          archived: Boolean(p.archivedAt),
        },
        peerMeta,
      };
    }),
  );
  return ok(res, serialize(rows));
});

messagesRouter.patch("/conversations/:id", requireAuth, async (req, res) => {
  const body = z
    .object({
      pinned: z.boolean().optional(),
      muted: z.boolean().optional(),
      archived: z.boolean().optional(),
      hidden: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid prefs");
  const part = await prisma.conversationParticipant.findFirst({
    where: { conversationId: req.params.id, userId: req.user!.id },
  });
  if (!part) return fail(res, 403, "FORBIDDEN", "Not a participant");
  const updated = await prisma.conversationParticipant.update({
    where: { id: part.id },
    data: {
      ...(body.data.pinned !== undefined ? { pinnedAt: body.data.pinned ? new Date() : null } : {}),
      ...(body.data.muted !== undefined ? { muted: body.data.muted } : {}),
      ...(body.data.archived !== undefined ? { archivedAt: body.data.archived ? new Date() : null } : {}),
      ...(body.data.hidden !== undefined ? { hiddenAt: body.data.hidden ? new Date() : null } : {}),
    },
  });
  return ok(res, serialize(updated));
});

messagesRouter.post("/block", requireAuth, async (req, res) => {
  const body = z.object({ peerUserId: z.string().uuid() }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "peerUserId required");
  if (body.data.peerUserId === req.user!.id) return fail(res, 400, "VALIDATION", "Cannot block yourself");
  await prisma.userBlock.upsert({
    where: { userId_blockedUserId: { userId: req.user!.id, blockedUserId: body.data.peerUserId } },
    create: { userId: req.user!.id, blockedUserId: body.data.peerUserId },
    update: {},
  });
  const shared = await prisma.conversationParticipant.findMany({
    where: { userId: req.user!.id },
    select: { conversationId: true },
  });
  const peerParts = await prisma.conversationParticipant.findMany({
    where: { userId: body.data.peerUserId, conversationId: { in: shared.map((s) => s.conversationId) } },
    select: { conversationId: true },
  });
  for (const p of peerParts) {
    await prisma.conversationParticipant.updateMany({
      where: { conversationId: p.conversationId, userId: req.user!.id },
      data: { hiddenAt: new Date() },
    });
  }
  return ok(res, { blocked: true });
});

messagesRouter.get("/conversations/:id", requireAuth, async (req, res) => {
  const ctx = await getConversationContext(String(req.params.id), req.user!.id);
  if (!ctx) return fail(res, 404, "NOT_FOUND", "Conversation not found");
  return ok(res, serialize(ctx));
});

messagesRouter.patch("/conversations/:id", requireAuth, async (req, res) => {
  const body = z
    .object({
      productId: z.string().uuid().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid update");
  const part = await prisma.conversationParticipant.findFirst({
    where: { conversationId: req.params.id, userId: req.user!.id },
  });
  if (!part) return fail(res, 403, "FORBIDDEN", "Not a participant");
  const updated = await prisma.conversation.update({
    where: { id: String(req.params.id) },
    data: {
      ...(body.data.productId !== undefined ? { productId: body.data.productId } : {}),
    },
  });
  return ok(res, serialize(updated));
});

messagesRouter.post("/conversations/:id/quote", requireAuth, async (req, res) => {
  const body = z
    .object({
      amountMinor: z.union([z.string(), z.number()]),
      currency: z.enum(["NGN", "CNY", "USD"]).default("CNY"),
      note: z.string().max(500).optional(),
      qty: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid quote");
  const amountMinor = BigInt(body.data.amountMinor);
  if (amountMinor <= 0n) return fail(res, 400, "VALIDATION", "Amount must be positive");
  try {
    const result = await upsertChatQuote({
      conversationId: String(req.params.id),
      sellerId: req.user!.id,
      amountMinor,
      currency: body.data.currency,
      note: body.data.note,
      qty: body.data.qty,
    });
    return ok(res, serialize(result), 201);
  } catch (e) {
    return fail(res, 400, "QUOTE_FAILED", e instanceof Error ? e.message : "Quote failed");
  }
});

messagesRouter.post("/conversations", requireAuth, async (req, res) => {
  const body = z
    .object({
      peerUserId: z.string().uuid(),
      subject: z.string().optional(),
      body: z.string().optional(),
      productId: z.string().uuid().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "peerUserId required");
  const conv = await prisma.$transaction(async (tx) => {
    const c = await tx.conversation.create({
      data: {
        subject: body.data.subject,
        productId: body.data.productId,
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
    include: {
      quote: {
        include: {
          seller: { select: { id: true, name: true } },
          rfq: { select: { id: true, title: true, qty: true } },
        },
      },
    },
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

/** Admin marks marketplace order shipped (e.g. when seller has not updated the app). */
adminRouter.post("/orders/:id/mark-shipped", async (req, res) => {
  const body = z
    .object({
      tracking: z.string().optional(),
      carrier: z.string().optional(),
      note: z.string().optional(),
    })
    .safeParse(req.body ?? {});
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid payload");

  const order = await prisma.marketOrder.findUnique({ where: { id: req.params.id } });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  if (!["IN_ESCROW", "SHIPPED"].includes(order.status)) {
    return fail(res, 400, "BAD_STATUS", `Cannot mark shipped from ${order.status}`);
  }

  const tracking = body.data.tracking?.trim() || order.tracking || `ADMIN-${order.id.slice(0, 8)}`;
  const updated = await prisma.marketOrder.update({
    where: { id: order.id },
    data: {
      status: "SHIPPED",
      tracking,
      ...(body.data.carrier !== undefined ? { carrier: body.data.carrier || null } : {}),
      ...(body.data.note?.trim()
        ? { sellerNote: order.sellerNote ? `${order.sellerNote}\n[Admin] ${body.data.note}` : `[Admin] ${body.data.note}` }
        : {}),
    },
    include: { items: true, user: { select: userSelect } },
  });

  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "order.mark_shipped",
      entity: "MarketOrder",
      entityId: order.id,
      meta: { tracking, previousStatus: order.status },
    },
  });

  await prisma.notification.create({
    data: {
      userId: order.userId,
      title: "Order marked as shipped",
      body: `MagnetPay ops marked your order shipped · Tracking: ${tracking}`,
    },
  });

  if (updated.shipmentId) {
    try {
      const linked = await prisma.shipment.findUnique({ where: { id: updated.shipmentId } });
      if (linked?.status === "HOLD_LOCKED") {
        await advanceShipmentOps({
          shipmentId: linked.id,
          status: "IN_TRANSIT",
          message: `Admin marked order shipped · ${tracking}`,
          skipSellerShipCheck: true,
          actor: "admin",
        });
      }
    } catch {
      /* shipment advance optional if already moved */
    }
  }

  return ok(res, serialize(updated));
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

adminRouter.get("/products/:id", async (req, res) => {
  const row = await prisma.product.findUnique({
    where: { id: req.params.id },
    include: {
      store: { include: { user: { select: userSelect } } },
      category: true,
      brand: true,
      media: { orderBy: { sortOrder: "asc" } },
      variants: { orderBy: { createdAt: "asc" } },
      reviews: {
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { user: { select: userSelect } },
      },
      _count: { select: { orderItems: true, reviews: true } },
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Product not found");
  return ok(res, serialize(row));
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

  // Product has `active` boolean — map moderation statuses
  let active = existing.active;
  let moderationStatus = existing.moderationStatus;
  if (body.data.active !== undefined) active = body.data.active;
  else if (body.data.status === "APPROVED") {
    active = true;
    moderationStatus = "ACTIVE";
  } else if (body.data.status === "HIDDEN") {
    active = false;
    moderationStatus = "HIDDEN";
  } else if (body.data.status === "REJECTED") {
    active = false;
    moderationStatus = "REJECTED";
  }

  const row = await prisma.product.update({
    where: { id: req.params.id },
    data: { active, moderationStatus },
    include: { store: true, category: true, brand: true },
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

adminRouter.get("/sellers/:id", async (req, res) => {
  const row = await prisma.sellerStore.findUnique({
    where: { id: req.params.id },
    include: {
      user: { select: userSelect },
      products: { orderBy: { createdAt: "desc" }, take: 50 },
      _count: { select: { products: true, members: true } },
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Seller store not found");
  return ok(res, serialize(row));
});

adminRouter.patch("/sellers/:id", async (req, res) => {
  const body = z
    .object({
      verified: z.boolean().optional(),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid body");

  const existing = await prisma.sellerStore.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Seller store not found");

  const row = await prisma.sellerStore.update({
    where: { id: req.params.id },
    data: body.data,
    include: {
      user: { select: userSelect },
      products: { orderBy: { createdAt: "desc" }, take: 50 },
      _count: { select: { products: true, members: true } },
    },
  });
  return ok(res, serialize(row));
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
  const marketOrder = await prisma.marketOrder.findFirst({
    where: { shipmentId: row.id },
    select: { id: true, status: true, tracking: true, supplier: true, escrowId: true },
  });
  return ok(res, serialize({ ...row, marketOrder }));
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
  const { getAdminAnalyticsOverview } = await import("../services/admin-analytics.js");
  return ok(res, serialize(await getAdminAnalyticsOverview()));
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

adminRouter.get("/compliance/limits", async (_req, res) => {
  const row = await getComplianceLimits();
  return ok(res, serialize(row));
});

adminRouter.put("/compliance/limits", async (req, res) => {
  const body = z
    .object({
      unverifiedNgnDailyCapMinor: z.number().int().nonnegative(),
      ngnTier1DailyCapMinor: z.number().int().nonnegative(),
      ngnTier2DailyCapMinor: z.number().int().nonnegative(),
      cnyDailyCapMinor: z.number().int().nonnegative(),
      minTierDeposit: z.number().int().min(0).max(3),
      minTierWithdraw: z.number().int().min(0).max(3),
      minTierCrossBorder: z.number().int().min(0).max(3),
      minTierMarketCheckout: z.number().int().min(0).max(3),
      minTierLogistics: z.number().int().min(0).max(3),
      allowBasicWhilePending: z.boolean(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid compliance limits");

  const row = await updateComplianceLimits(body.data);
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "compliance.limits.update",
      entity: "ComplianceLimits",
      entityId: row.id,
      meta: body.data,
    },
  });
  return ok(res, serialize(row));
});

adminRouter.get("/logistics/pricing", async (_req, res) => {
  const row = await getFreightPricing();
  return ok(res, serialize(row));
});

adminRouter.put("/logistics/pricing", async (_req, res) => {
  return fail(
    res,
    410,
    "DEPRECATED",
    "Global CBM/weight pricing is deprecated. Use /admin/logistics/parcel-types and /admin/logistics/estimate-config instead.",
  );
});

adminRouter.get("/logistics/estimate-config", async (_req, res) => {
  const row = await getLogisticsEstimateConfig();
  return ok(res, serialize(row));
});

adminRouter.put("/logistics/estimate-config", async (req, res) => {
  const body = z
    .object({
      usdNgnEstimateRate: z.number().int().positive(),
      estimateDisclaimer: z.string().min(10),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid estimate config");

  const row = await prisma.logisticsEstimateConfig.upsert({
    where: { id: "default" },
    create: { id: "default", ...body.data },
    update: body.data,
  });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "logistics.estimate_config.update",
      entity: "LogisticsEstimateConfig",
      entityId: row.id,
      meta: body.data,
    },
  });
  return ok(res, serialize(row));
});

adminRouter.get("/logistics/parcel-types", async (_req, res) => {
  const rows = await prisma.parcelType.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return ok(res, serialize(rows));
});

adminRouter.post("/logistics/parcel-types", async (req, res) => {
  const body = z
    .object({
      code: z.string().min(2).max(32),
      name: z.string().min(2),
      baseMinor: z.number().int().nonnegative(),
      ratePerKgMinor: z.number().int().nonnegative(),
      active: z.boolean().default(true),
      sortOrder: z.number().int().default(0),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid parcel type");

  const row = await prisma.parcelType.create({ data: body.data });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "logistics.parcel_type.create",
      entity: "ParcelType",
      entityId: row.id,
      meta: body.data,
    },
  });
  return ok(res, serialize(row), 201);
});

adminRouter.patch("/logistics/parcel-types/:id", async (req, res) => {
  const body = z
    .object({
      name: z.string().min(2).optional(),
      baseMinor: z.number().int().nonnegative().optional(),
      ratePerKgMinor: z.number().int().nonnegative().optional(),
      active: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid parcel type patch");

  const existing = await prisma.parcelType.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Parcel type not found");

  const row = await prisma.parcelType.update({ where: { id: req.params.id }, data: body.data });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "logistics.parcel_type.update",
      entity: "ParcelType",
      entityId: row.id,
      meta: body.data,
    },
  });
  return ok(res, serialize(row));
});

adminRouter.post("/logistics/parcel-types/preview", async (req, res) => {
  const body = z
    .object({
      parcelTypeId: z.string().min(1),
      weightKg: z.number().positive(),
      declaredUsd: z.number().nonnegative().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid preview input");
  try {
    const breakdown = await estimateQuoteFromParcelType(body.data);
    return ok(res, serialize(breakdown));
  } catch (e) {
    return fail(res, 400, "PREVIEW_FAILED", e instanceof Error ? e.message : "Preview failed");
  }
});

adminRouter.post("/logistics/pricing/preview", async (req, res) => {
  const body = z
    .object({
      parcelTypeId: z.string().min(1),
      weightKg: z.number().positive(),
      declaredUsd: z.number().nonnegative().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid preview input — use parcelTypeId + weightKg");
  try {
    const breakdown = await estimateQuoteFromParcelType(body.data);
    return ok(res, serialize(breakdown));
  } catch (e) {
    return fail(res, 400, "PREVIEW_FAILED", e instanceof Error ? e.message : "Preview failed");
  }
});

adminRouter.get("/logistics/partners", async (_req, res) => {
  const rows = await prisma.logisticsPartner.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] });
  return ok(res, serialize(rows));
});

adminRouter.get("/logistics/partners/:id", async (req, res) => {
  const row = await prisma.logisticsPartner.findUnique({
    where: { id: req.params.id },
    include: {
      rates: {
        orderBy: [{ sortOrder: "asc" }, { mode: "asc" }],
        include: { parcelType: { select: { id: true, code: true, name: true } } },
      },
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Partner not found");
  return ok(res, serialize(row));
});

adminRouter.post("/logistics/partners", async (req, res) => {
  const body = z
    .object({
      name: z.string().min(2),
      code: z.string().min(2).max(32),
      kind: z.enum(["FREIGHT_FORWARDER", "WAREHOUSE", "CUSTOMS_BROKER", "LAST_MILE"]).default("FREIGHT_FORWARDER"),
      modes: z.array(z.enum(["AIR", "SEA", "EXPRESS", "CONSOLIDATED"])).min(1),
      active: z.boolean().default(true),
      rating: z.number().min(0).max(5).optional(),
      serviceLabel: z.string().optional(),
      contactName: z.string().optional(),
      contactPhone: z.string().optional(),
      contactEmail: z.string().email().optional().or(z.literal("")),
      notes: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid partner");

  const row = await prisma.logisticsPartner.create({
    data: {
      name: body.data.name,
      code: body.data.code.toUpperCase(),
      kind: body.data.kind,
      modes: body.data.modes,
      active: body.data.active,
      rating: body.data.rating,
      serviceLabel: body.data.serviceLabel,
      contactName: body.data.contactName,
      contactPhone: body.data.contactPhone,
      contactEmail: body.data.contactEmail || null,
      notes: body.data.notes,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "logistics.partner.create",
      entity: "LogisticsPartner",
      entityId: row.id,
      meta: { code: row.code, name: row.name },
    },
  });
  return ok(res, serialize(row), 201);
});

adminRouter.patch("/logistics/partners/:id", async (req, res) => {
  const body = z
    .object({
      name: z.string().min(2).optional(),
      code: z.string().min(2).max(32).optional(),
      kind: z.enum(["FREIGHT_FORWARDER", "WAREHOUSE", "CUSTOMS_BROKER", "LAST_MILE"]).optional(),
      modes: z.array(z.enum(["AIR", "SEA", "EXPRESS", "CONSOLIDATED"])).min(1).optional(),
      active: z.boolean().optional(),
      rating: z.number().min(0).max(5).nullable().optional(),
      serviceLabel: z.string().nullable().optional(),
      contactName: z.string().nullable().optional(),
      contactPhone: z.string().nullable().optional(),
      contactEmail: z.string().email().nullable().optional().or(z.literal("")),
      notes: z.string().nullable().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid partner update");

  const existing = await prisma.logisticsPartner.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Partner not found");

  const row = await prisma.logisticsPartner.update({
    where: { id: req.params.id },
    data: {
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(body.data.code !== undefined ? { code: body.data.code.toUpperCase() } : {}),
      ...(body.data.kind !== undefined ? { kind: body.data.kind } : {}),
      ...(body.data.modes !== undefined ? { modes: body.data.modes } : {}),
      ...(body.data.active !== undefined ? { active: body.data.active } : {}),
      ...(body.data.rating !== undefined ? { rating: body.data.rating } : {}),
      ...(body.data.serviceLabel !== undefined ? { serviceLabel: body.data.serviceLabel } : {}),
      ...(body.data.contactName !== undefined ? { contactName: body.data.contactName } : {}),
      ...(body.data.contactPhone !== undefined ? { contactPhone: body.data.contactPhone } : {}),
      ...(body.data.contactEmail !== undefined ? { contactEmail: body.data.contactEmail || null } : {}),
      ...(body.data.notes !== undefined ? { notes: body.data.notes } : {}),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "logistics.partner.update",
      entity: "LogisticsPartner",
      entityId: row.id,
      meta: { code: row.code, active: row.active },
    },
  });
  return ok(res, serialize(row));
});

adminRouter.get("/logistics/partners/:id/rates", async (req, res) => {
  const partner = await prisma.logisticsPartner.findUnique({ where: { id: req.params.id } });
  if (!partner) return fail(res, 404, "NOT_FOUND", "Partner not found");
  const rows = await prisma.logisticsPartnerRate.findMany({
    where: { partnerId: partner.id },
    include: { parcelType: { select: { id: true, code: true, name: true } } },
    orderBy: [{ sortOrder: "asc" }, { mode: "asc" }],
  });
  return ok(res, serialize(rows));
});

adminRouter.post("/logistics/partners/:id/rates", async (req, res) => {
  const partner = await prisma.logisticsPartner.findUnique({ where: { id: req.params.id } });
  if (!partner) return fail(res, 404, "NOT_FOUND", "Partner not found");
  const body = z
    .object({
      parcelTypeId: z.string().uuid().nullable().optional(),
      mode: z.enum(["AIR", "SEA", "EXPRESS", "CONSOLIDATED"]).default("SEA"),
      baseSurchargeMinor: z.number().int().nonnegative().default(0),
      rateMultiplierBps: z.number().int().positive().default(10000),
      etaLabel: z.string().min(3).default("26–32 days"),
      badgeLabel: z.string().nullable().optional(),
      includes: z.array(z.string()).optional(),
      ecoFriendly: z.boolean().default(false),
      active: z.boolean().default(true),
      sortOrder: z.number().int().default(0),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid rate card");

  const row = await prisma.logisticsPartnerRate.create({
    data: {
      partnerId: partner.id,
      parcelTypeId: body.data.parcelTypeId ?? null,
      mode: body.data.mode,
      baseSurchargeMinor: body.data.baseSurchargeMinor,
      rateMultiplierBps: body.data.rateMultiplierBps,
      etaLabel: body.data.etaLabel,
      badgeLabel: body.data.badgeLabel ?? null,
      includes: body.data.includes ?? ["Insurance", "Customs paperwork"],
      ecoFriendly: body.data.ecoFriendly,
      active: body.data.active,
      sortOrder: body.data.sortOrder,
    },
    include: { parcelType: { select: { id: true, code: true, name: true } } },
  });
  return ok(res, serialize(row), 201);
});

adminRouter.patch("/logistics/partners/:partnerId/rates/:rateId", async (req, res) => {
  const existing = await prisma.logisticsPartnerRate.findFirst({
    where: { id: req.params.rateId, partnerId: req.params.partnerId },
  });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Rate not found");
  const body = z
    .object({
      parcelTypeId: z.string().uuid().nullable().optional(),
      mode: z.enum(["AIR", "SEA", "EXPRESS", "CONSOLIDATED"]).optional(),
      baseSurchargeMinor: z.number().int().nonnegative().optional(),
      rateMultiplierBps: z.number().int().positive().optional(),
      etaLabel: z.string().min(3).optional(),
      badgeLabel: z.string().nullable().optional(),
      includes: z.array(z.string()).optional(),
      ecoFriendly: z.boolean().optional(),
      active: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid rate update");

  const row = await prisma.logisticsPartnerRate.update({
    where: { id: existing.id },
    data: {
      ...(body.data.parcelTypeId !== undefined ? { parcelTypeId: body.data.parcelTypeId } : {}),
      ...(body.data.mode !== undefined ? { mode: body.data.mode } : {}),
      ...(body.data.baseSurchargeMinor !== undefined ? { baseSurchargeMinor: body.data.baseSurchargeMinor } : {}),
      ...(body.data.rateMultiplierBps !== undefined ? { rateMultiplierBps: body.data.rateMultiplierBps } : {}),
      ...(body.data.etaLabel !== undefined ? { etaLabel: body.data.etaLabel } : {}),
      ...(body.data.badgeLabel !== undefined ? { badgeLabel: body.data.badgeLabel } : {}),
      ...(body.data.includes !== undefined ? { includes: body.data.includes } : {}),
      ...(body.data.ecoFriendly !== undefined ? { ecoFriendly: body.data.ecoFriendly } : {}),
      ...(body.data.active !== undefined ? { active: body.data.active } : {}),
      ...(body.data.sortOrder !== undefined ? { sortOrder: body.data.sortOrder } : {}),
    },
    include: { parcelType: { select: { id: true, code: true, name: true } } },
  });
  return ok(res, serialize(row));
});

adminRouter.delete("/logistics/partners/:partnerId/rates/:rateId", async (req, res) => {
  const existing = await prisma.logisticsPartnerRate.findFirst({
    where: { id: req.params.rateId, partnerId: req.params.partnerId },
  });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Rate not found");
  await prisma.logisticsPartnerRate.delete({ where: { id: existing.id } });
  return ok(res, { ok: true });
});

adminRouter.get("/logistics/shipment-flow", async (_req, res) => {
  const parcelTypes = await listActiveParcelTypes();
  const estimateConfig = await getLogisticsEstimateConfig();
  return ok(
    res,
    serialize({
      next: SHIPMENT_NEXT,
      parcelTypes,
      estimateConfig,
      defaults: DEFAULT_FREIGHT_PRICING,
      disclaimer: estimateConfig.estimateDisclaimer ?? DEFAULT_ESTIMATE_DISCLAIMER,
    }),
  );
});

adminRouter.post("/shipments/:id/advance", async (req, res) => {
  const body = z
    .object({
      status: z.enum(["IN_TRANSIT", "CUSTOMS", "SETTLEMENT_PENDING", "READY_FOR_POD"]).optional(),
      message: z.string().optional(),
      skipSellerShipCheck: z.boolean().optional(),
    })
    .safeParse(req.body ?? {});
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid advance payload");

  try {
    const updated = await advanceShipmentOps({
      shipmentId: req.params.id,
      status: body.data.status,
      message: body.data.message,
      skipPodCheck: true,
      skipSellerShipCheck: body.data.skipSellerShipCheck === true,
      actor: "admin",
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: "shipment.advance",
        entity: "Shipment",
        entityId: updated.id,
        meta: { status: updated.status, ref: updated.ref },
      },
    });
    return ok(res, serialize(updated));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Advance failed";
    if (msg.includes("not found")) return fail(res, 404, "NOT_FOUND", msg);
    return fail(res, 400, "BAD_STATE", msg);
  }
});

adminRouter.post("/shipments/:id/settle", async (req, res) => {
  const body = z
    .object({
      finalMinor: z.union([z.string(), z.number()]).optional(),
      breakdown: z
        .array(z.object({ label: z.string().min(1), amountMinor: z.number().int().positive() }))
        .optional(),
      notes: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid settle payload");

  try {
    const result = await settleShipmentOps({
      shipmentId: req.params.id,
      finalMinor: body.data.finalMinor != null ? BigInt(body.data.finalMinor) : undefined,
      breakdown: body.data.breakdown,
      notes: body.data.notes,
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: "shipment.settle",
        entity: "Shipment",
        entityId: req.params.id,
        meta: {
          finalMinor: String(result.settlement.finalMinor),
          topUpMinor: String(result.settlement.topUpMinor),
          cashbackMinor: String(result.settlement.cashbackMinor),
          breakdown: body.data.breakdown ?? null,
        },
      },
    });
    return ok(res, serialize(result));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Settle failed";
    if (msg.includes("not found")) return fail(res, 404, "NOT_FOUND", msg);
    if (msg.includes("Already settled")) return fail(res, 400, "ALREADY_SETTLED", msg);
    return fail(res, 400, "SETTLE_FAILED", msg);
  }
});

adminRouter.get("/shipments/:id/documents", async (req, res) => {
  const shipment = await prisma.shipment.findUnique({
    where: { id: req.params.id },
    include: { documents: { orderBy: { createdAt: "desc" } } },
  });
  if (!shipment) return fail(res, 404, "NOT_FOUND", "Shipment not found");
  return ok(res, serialize(shipment.documents));
});

adminRouter.post("/shipments/:id/documents", async (req, res) => {
  const body = z
    .object({
      kind: z.string().min(1),
      name: z.string().min(1),
      url: z.string().min(4),
      note: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid document");
  if (body.data.kind.startsWith("pod_")) {
    return fail(res, 403, "FORBIDDEN", "Proof of delivery can only be submitted by the buyer");
  }

  try {
    const doc = await attachShipmentDocument({
      shipmentId: req.params.id,
      kind: body.data.kind,
      name: body.data.name,
      url: body.data.url,
      eventMessage: body.data.note?.trim() || `Ops uploaded: ${body.data.name}`,
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: "shipment.document.add",
        entity: "ShipmentDocument",
        entityId: doc.id,
        meta: { shipmentId: req.params.id, kind: body.data.kind, name: body.data.name },
      },
    });
    return ok(res, serialize(doc), 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Upload failed";
    if (msg.includes("not found")) return fail(res, 404, "NOT_FOUND", msg);
    return fail(res, 400, "UPLOAD_FAILED", msg);
  }
});

adminRouter.delete("/shipments/:id/documents/:docId", async (req, res) => {
  try {
    await removeShipmentDocument({ shipmentId: req.params.id, documentId: req.params.docId });
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: "shipment.document.remove",
        entity: "ShipmentDocument",
        entityId: req.params.docId,
        meta: { shipmentId: req.params.id },
      },
    });
    return ok(res, serialize({ ok: true }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Delete failed";
    if (msg.includes("not found")) return fail(res, 404, "NOT_FOUND", msg);
    return fail(res, 400, "DELETE_FAILED", msg);
  }
});

adminRouter.get("/logistics/document-kinds", async (_req, res) => {
  return ok(res, serialize(SHIPMENT_DOCUMENT_KINDS.filter((k) => !k.startsWith("pod_"))));
});

adminRouter.get("/records", async (req, res) => {
  const domain = typeof req.query.domain === "string" ? req.query.domain : "";
  if (!domain) return fail(res, 400, "VALIDATION", "domain query required");
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  await seedAdminRecords().catch(() => {});
  const rows = await listAdminRecords(domain, status);
  return ok(res, serialize(rows));
});

adminRouter.get("/records/:id", async (req, res) => {
  await seedAdminRecords().catch(() => {});
  const row = await getAdminRecord(req.params.id);
  if (!row) return fail(res, 404, "NOT_FOUND", "Record not found");
  return ok(res, serialize(row));
});

adminRouter.post("/records", async (req, res) => {
  const body = z
    .object({
      domain: z.string().min(1),
      externalId: z.string().optional(),
      title: z.string().min(1),
      subtitle: z.string().optional(),
      status: z.string().optional(),
      payload: z.record(z.unknown()).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid body");
  const row = await createAdminRecord(body.data);
  return ok(res, serialize(row));
});

adminRouter.patch("/records/:id", async (req, res) => {
  const body = z
    .object({
      title: z.string().min(1).optional(),
      subtitle: z.string().optional(),
      status: z.string().optional(),
      payload: z.record(z.unknown()).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid body");
  const existing = await getAdminRecord(req.params.id);
  if (!existing) return fail(res, 404, "NOT_FOUND", "Record not found");
  const row = await patchAdminRecord(req.params.id, body.data);
  return ok(res, serialize(row));
});

registerAdminExtensions(adminRouter);
