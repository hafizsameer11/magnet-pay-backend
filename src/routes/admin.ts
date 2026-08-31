import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { activatePendingSellerProducts } from "../services/seller-kyb.js";
import {fail, ok, requireAuth, requireAdmin, serialize, param } from "../lib/http.js";
import { z } from "zod";
import { mpEmail, notifyConversationPeers, notifyUser, notifyUsers } from "../services/user-notify.js";
import { formatMoney, recordTx, settleEscrowRelease } from "../services/ledger.js";
import { getConversationContext, upsertChatQuote } from "../services/chat-quote.js";
import {
  attachForConversation,
  formatInboxTime,
  inboxPeerRole,
} from "../services/inbox.js";
import { translateChatText } from "../services/chat-translate.js";
import {
  ensureDefaultFxFeeConfig,
  feeConfigKeyToPair,
  listAdminFxPairs,
  rateToFeeConfigValue,
  syncFeeConfigRatesToFxTable,
  syncFxTableToFeeConfig,
} from "../services/fx-rates-sync.js";
import {
  DEFAULT_ESTIMATE_DISCLAIMER,
  DEFAULT_FREIGHT_PRICING,
  estimateFreightMinor,
  estimateQuoteFromParcelType,
  getFreightPricing,
  getLogisticsEstimateConfig,
  listActiveParcelTypes,
} from "../services/freight-pricing.js";
import {
  originHubSchema,
  packagingTypeSchema,
} from "../services/logistics-product-config.js";
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
  upsertSupportTicketRecord,
  listTicketsForUser,
  getSupportTicketByConversationId,
  isSupportSubject,
  supportTopicFromSubject,
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
    where: { id: param(req, "id"), userId: req.user!.id },
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
  const me = req.user!;
  const parts = await prisma.conversationParticipant.findMany({
    where: {
      userId: me.id,
      hiddenAt: null,
      ...(showArchived ? {} : { archivedAt: null }),
    },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
          participants: {
            include: {
              user: { select: { id: true, name: true, phone: true, role: true, platformRole: true } },
            },
          },
        },
      },
    },
    orderBy: [{ pinnedAt: "desc" }, { conversation: { updatedAt: "desc" } }],
  });
  const rows = await Promise.all(
    parts.map(async (p) => {
      const peerPart = p.conversation.participants.find((x) => x.user.id !== me.id);
      const peer = peerPart?.user;
      const mePart = p.conversation.participants.find((x) => x.user.id === me.id)?.user;
      const amSeller = mePart?.role === "SELLER" || mePart?.role === "BOTH";
      const peerMeta = peer ? await peerMetaForUser(peer.id, p.conversation.id) : null;
      const unreadCount = await prisma.message.count({
        where: {
          conversationId: p.conversation.id,
          senderId: { not: me.id },
          ...(p.lastReadAt ? { createdAt: { gt: p.lastReadAt } } : {}),
        },
      });
      const attach = await attachForConversation({
        latestQuoteId: p.conversation.latestQuoteId,
        subject: p.conversation.subject,
        productId: p.conversation.productId,
      });
      const latest = p.conversation.messages[0];
      return {
        ...p.conversation,
        myPrefs: {
          pinned: Boolean(p.pinnedAt),
          muted: p.muted,
          archived: Boolean(p.archivedAt),
          lastReadAt: p.lastReadAt?.toISOString() ?? null,
        },
        peerMeta,
        unreadCount,
        inboxTime: formatInboxTime(latest?.createdAt?.toISOString() ?? p.conversation.updatedAt.toISOString()),
        peerRole: peer
          ? inboxPeerRole(peer.role, peer.platformRole, amSeller)
          : mePart?.platformRole !== "USER"
            ? "Mediator"
            : "Supplier",
        attach,
        inboxTab: attach?.tab ?? null,
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
    where: { conversationId: param(req, "id"), userId: req.user!.id },
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
  const ctx = await getConversationContext(String(param(req, "id")), req.user!.id);
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
    where: { conversationId: param(req, "id"), userId: req.user!.id },
  });
  if (!part) return fail(res, 403, "FORBIDDEN", "Not a participant");
  const updated = await prisma.conversation.update({
    where: { id: String(param(req, "id")) },
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
      conversationId: String(param(req, "id")),
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
  if (body.data.body) {
    void notifyConversationPeers(conv!.id, req.user!.id, {
      title: "New message",
      body: body.data.body.slice(0, 120),
      href: `/messages/${conv!.id}`,
    });
  } else {
    notifyUser(body.data.peerUserId, {
      title: "New conversation",
      body: body.data.subject ?? "Someone started a chat with you",
      href: `/messages/${conv!.id}`,
    });
  }
  return ok(res, serialize(conv), 201);
});

messagesRouter.get("/conversations/:id/messages", requireAuth, async (req, res) => {
  const me = req.user!.id;
  const conversationId = String(param(req, "id"));
  const part = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId: me },
  });
  if (!part) return fail(res, 403, "FORBIDDEN", "Not a participant");
  const peerPart = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId: { not: me } },
    select: { lastReadAt: true },
  });
  const peerLastRead = peerPart?.lastReadAt ?? null;
  const messages = await prisma.message.findMany({
    where: { conversationId },
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
  const rows = messages.map((m) => ({
    ...m,
    readByPeer:
      m.senderId === me ? (peerLastRead ? peerLastRead >= m.createdAt : false) : undefined,
  }));
  return ok(res, serialize(rows));
});

messagesRouter.post("/conversations/:id/read", requireAuth, async (req, res) => {
  const conversationId = String(param(req, "id"));
  const part = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId: req.user!.id },
  });
  if (!part) return fail(res, 403, "FORBIDDEN", "Not a participant");
  const now = new Date();
  await prisma.conversationParticipant.update({
    where: { id: part.id },
    data: { lastReadAt: now },
  });
  return ok(res, { readAt: now.toISOString() });
});

messagesRouter.post("/translate", requireAuth, async (req, res) => {
  const body = z
    .object({
      text: z.string().min(1).max(4000),
      targetLang: z.enum(["en", "zh"]).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "text required");
  try {
    const result = await translateChatText(body.data.text, body.data.targetLang);
    return ok(res, result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Translation failed";
    const code = msg.includes("OPENAI_API_KEY") ? 503 : 502;
    return fail(res, code, "TRANSLATE_FAILED", msg);
  }
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
    where: { conversationId: param(req, "id"), userId: req.user!.id },
  });
  if (!part) return fail(res, 403, "FORBIDDEN", "Not a participant");
  const conv = await prisma.conversation.findUnique({ where: { id: param(req, "id") } });
  if (conv && isSupportSubject(conv.subject)) {
    const ticket = await getSupportTicketByConversationId(conv.id);
    if (ticket?.status === "closed") {
      return fail(res, 403, "CLOSED", "This support chat has been closed");
    }
  }
  const msg = await prisma.message.create({
    data: {
      conversationId: param(req, "id"),
      senderId: req.user!.id,
      body: text || (attachmentUrl ? "Attachment" : ""),
      attachmentUrl,
    },
  });
  await prisma.conversation.update({
    where: { id: param(req, "id") },
    data: { updatedAt: new Date() },
  });
  void notifyConversationPeers(param(req, "id"), req.user!.id, {
    title: "New message",
    body: (text || "Attachment").slice(0, 120),
    href: `/messages/${param(req, "id")}`,
  });
  return ok(res, serialize(msg), 201);
});

messagesRouter.get("/support", requireAuth, async (req, res) => {
  const me = req.user!;
  const parts = await prisma.conversationParticipant.findMany({
    where: {
      userId: me.id,
      hiddenAt: null,
      conversation: { subject: { startsWith: "Support ·" } },
    },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
    orderBy: { conversation: { updatedAt: "desc" } },
  });
  const tickets = await listTicketsForUser(me.id);
  const statusByConv = new Map(
    tickets.map((t) => {
      const p = (t.payload ?? {}) as Record<string, unknown>;
      return [String(p.conversationId ?? ""), t.status ?? "open"];
    }),
  );
  const rows = parts.map((p) => {
    const conv = p.conversation;
    const latest = conv.messages[0];
    const status = statusByConv.get(conv.id) ?? "open";
    return {
      id: conv.id,
      topic: supportTopicFromSubject(conv.subject),
      status,
      closed: status === "closed",
      updatedAt: conv.updatedAt.toISOString(),
      lastMessage: latest?.body ?? null,
      lastMessageAt: latest?.createdAt?.toISOString() ?? null,
    };
  });
  return ok(res, serialize(rows));
});

messagesRouter.post("/support", requireAuth, async (req, res) => {
  const body = z
    .object({
      topic: z.string().min(2),
      message: z.string().optional().default(""),
      attachmentUrl: z.string().min(1).optional().nullable(),
      conversationId: z.string().uuid().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "topic and message required");
  const text = (body.data.message ?? "").trim();
  const attachmentUrl = body.data.attachmentUrl || null;
  if (!text && !attachmentUrl) return fail(res, 400, "VALIDATION", "message or attachment required");
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
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { id: true, name: true },
  });
  if (!user) return fail(res, 404, "NOT_FOUND", "User not found");

  if (body.data.conversationId) {
    const convId = body.data.conversationId;
    const part = await prisma.conversationParticipant.findFirst({
      where: { conversationId: convId, userId: req.user!.id },
      include: { conversation: true },
    });
    if (!part || !isSupportSubject(part.conversation.subject)) {
      return fail(res, 404, "NOT_FOUND", "Support chat not found");
    }
    const ticket = await getSupportTicketByConversationId(convId);
    if (ticket?.status === "closed") {
      return fail(res, 403, "CLOSED", "This support chat has been closed");
    }
    const msg = await prisma.message.create({
      data: {
        conversationId: convId,
        senderId: req.user!.id,
        body: text || "Attachment",
        attachmentUrl,
      },
    });
    await prisma.conversation.update({
      where: { id: convId },
      data: { updatedAt: new Date() },
    });
    await upsertSupportTicketRecord({
      userId: user.id,
      userName: user.name,
      topic: supportTopicFromSubject(part.conversation.subject),
      conversationId: convId,
      channel: "in_app",
    }).catch(() => {});
    notifyUser(admin.id, {
      title: "Support message",
      body: `[${supportTopicFromSubject(part.conversation.subject)}] ${(text || "Attachment").slice(0, 120)}`,
      href: `/messages/${convId}`,
    });
    return ok(res, serialize({ conversationId: convId, message: msg }));
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
        body: text || "Attachment",
        attachmentUrl,
      },
    });
    return { conversationId: c.id, message: msg };
  });
  await upsertSupportTicketRecord({
    userId: user.id,
    userName: user.name,
    topic: body.data.topic,
    conversationId: conv.conversationId,
    channel: "in_app",
  }).catch(() => {});
  notifyUser(admin.id, {
    title: "New support ticket",
    body: `[${body.data.topic}] ${(text || "Attachment").slice(0, 120)}`,
    href: `/messages/${conv.conversationId}`,
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
    where: { id: param(req, "id") },
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
  const existing = await prisma.kycApplication.findUnique({ where: { id: param(req, "id") } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "KYC application not found");

  const prevPayload = (existing.payload as Record<string, unknown> | null) ?? {};
  const app = await prisma.kycApplication.update({
    where: { id: param(req, "id") },
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
  notifyUser(app.userId, {
    title: `KYC ${verdict}`,
    body: body.data.note ? body.data.note : `Your KYC application was ${verdict}.`,
    href: "/kyc-status",
    emailPref: "emailKyc",
    emailSubject: `KYC ${verdict}`,
    emailText: mpEmail(user?.name, [
      `Your MagnetPay KYC application was ${verdict}.`,
      ...(body.data.note ? [body.data.note] : []),
    ]),
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
    where: { id: param(req, "id") },
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
  const existing = await prisma.businessProfile.findUnique({ where: { id: param(req, "id") } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "KYB profile not found");

  const prevDocs = (existing.documents as Record<string, unknown> | null) ?? {};
  const profile = await prisma.businessProfile.update({
    where: { id: param(req, "id") },
    data: {
      status: body.data.status,
      documents: (body.data.note ? { ...prevDocs, adminNote: body.data.note } : prevDocs) as object,
    },
    include: { user: { select: { id: true, name: true, phone: true, email: true } } },
  });
  if (body.data.status === "APPROVED") {
    await prisma.sellerStore.updateMany({
      where: { userId: profile.userId },
      data: { verified: true },
    });
    await activatePendingSellerProducts(profile.userId);
  } else if (body.data.status === "REJECTED") {
    await prisma.sellerStore.updateMany({
      where: { userId: profile.userId },
      data: { verified: false },
    });
  }
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
  notifyUser(profile.userId, {
    title: `Business verification ${verdict}`,
    body: body.data.note ? body.data.note : `Your KYB verification was ${verdict}.`,
    href: "/kyc-status",
    emailPref: "emailKyc",
    emailSubject: `Business verification ${verdict}`,
    emailText: mpEmail(user?.name, [
      `Your MagnetPay business (KYB) verification was ${verdict}.`,
      ...(body.data.note ? [body.data.note] : []),
    ]),
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
    include: {
      milestones: true,
      disputes: true,
      buyer: { select: { id: true, name: true, phone: true } },
      seller: { select: { id: true, name: true, phone: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const orderLinks = await prisma.marketOrder.findMany({
    where: { escrowId: { in: rows.map((r) => r.id) } },
    select: { id: true, escrowId: true },
  });
  const orderByEscrow = new Map(orderLinks.map((o) => [o.escrowId!, o.id]));
  return ok(
    res,
    serialize(
      rows.map((r) => ({
        ...r,
        orderId: orderByEscrow.get(r.id) ?? null,
      })),
    ),
  );
});

adminRouter.post("/escrows/:id/resolve", async (req, res) => {
  const body = z.object({ outcome: z.string().min(3) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "outcome required");
  const escrow = await prisma.escrow.update({
    where: { id: param(req, "id") },
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
  const full = await prisma.escrow.findUnique({
    where: { id: escrow.id },
    select: { buyerId: true, sellerId: true, title: true },
  });
  notifyUsers([full?.buyerId, full?.sellerId], {
    title: "Escrow dispute resolved",
    body: body.data.outcome,
    href: `/escrow/${escrow.id}`,
    emailPref: "emailEscrow",
    emailSubject: "Escrow dispute resolved",
    emailText: mpEmail(null, [`Dispute on escrow "${full?.title ?? escrow.id}" was resolved: ${body.data.outcome}`]),
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
    where: { id: param(req, "id") },
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

  const existing = await prisma.user.findUnique({ where: { id: param(req, "id") } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "User not found");

  const data: { name?: string; role?: "BUYER" | "SELLER" | "BOTH"; platformRole?: "USER" | "ADMIN" | "SUPER_ADMIN" } =
    {};
  if (body.data.name !== undefined) data.name = body.data.name;
  if (body.data.role !== undefined) data.role = body.data.role;
  if (body.data.platformRole !== undefined) data.platformRole = body.data.platformRole;

  const user =
    Object.keys(data).length > 0
      ? await prisma.user.update({ where: { id: param(req, "id") }, data })
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

adminRouter.post("/users/:id/open-chat", async (req, res) => {
  const targetUserId = param(req, "id");
  const adminId = req.user!.id;
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, name: true } });
  if (!target) return fail(res, 404, "NOT_FOUND", "User not found");

  const adminConversations = await prisma.conversationParticipant.findMany({
    where: { userId: adminId },
    select: { conversationId: true },
  });
  const existing = await prisma.conversationParticipant.findFirst({
    where: {
      userId: targetUserId,
      conversationId: { in: adminConversations.map((p) => p.conversationId) },
    },
    select: { conversationId: true },
  });

  if (existing) {
    return ok(res, serialize({ conversationId: existing.conversationId, created: false }));
  }

  const conv = await prisma.conversation.create({
    data: {
      subject: `Support · ${target.name}`,
      participants: {
        create: [{ userId: adminId }, { userId: targetUserId }],
      },
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: adminId,
      action: "chat.open",
      entity: "Conversation",
      entityId: conv.id,
      meta: { targetUserId },
    },
  });
  return ok(res, serialize({ conversationId: conv.id, created: true }), 201);
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
    where: { id: param(req, "id") },
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

  const existing = await prisma.withdrawal.findUnique({ where: { id: param(req, "id") } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Withdrawal not found");

  // WithdrawalStatus: PENDING | PROCESSING | SUCCEEDED | FAILED
  const mapped = body.data.status === "APPROVED" ? ("SUCCEEDED" as const) : ("FAILED" as const);
  const row = await prisma.withdrawal.update({
    where: { id: param(req, "id") },
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
  notifyUser(row.userId, {
    title: `Withdrawal ${verdict}`,
    body: `Your withdrawal of ${amount} was ${verdict}.`,
    href: "/notifications",
    emailPref: "emailTransfers",
    emailSubject: `Withdrawal ${verdict}`,
    emailText: mpEmail(user?.name, [`Your withdrawal of ${amount} was ${verdict}.`]),
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
      items: { include: { product: { select: { id: true, title: true, imageUrl: true } } } },
      user: { select: userSelect },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminRouter.get("/orders/:id", async (req, res) => {
  const row = await prisma.marketOrder.findUnique({
    where: { id: param(req, "id") },
    include: {
      items: {
        include: {
          product: {
            include: {
              store: { select: { id: true, name: true } },
              category: { select: { name: true } },
              brand: { select: { name: true } },
            },
          },
        },
      },
      user: { select: userSelect },
      shipment: true,
      _count: { select: { notes: true } },
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Order not found");

  const escrow = row.escrowId
    ? await prisma.escrow.findUnique({
        where: { id: row.escrowId },
        include: { seller: { select: { id: true, name: true } } },
      })
    : null;

  const [fxRow, feeRow] = await Promise.all([
    prisma.fxRate.findUnique({ where: { pair: "CNY_NGN" } }),
    prisma.feeConfig.findUnique({ where: { key: "escrow_fee_bps" } }),
  ]);

  return ok(
    res,
    serialize({
      ...row,
      escrow,
      fxCnyNgn: fxRow ? Number(fxRow.rate) : 229.04,
      platformFeeBps: feeRow?.value ?? 250,
    }),
  );
});

adminRouter.post("/orders/:id/cancel", async (req, res) => {
  const existing = await prisma.marketOrder.findUnique({ where: { id: param(req, "id") } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Order not found");

  const row = await prisma.marketOrder.update({
    where: { id: param(req, "id") },
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

  const order = await prisma.marketOrder.findUnique({ where: { id: param(req, "id") } });
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

  notifyUser(order.userId, {
    title: "Order marked as shipped",
    body: `MagnetPay ops marked your order shipped · Tracking: ${tracking}`,
    href: `/market/order/${order.id}`,
    emailPref: "emailEscrow",
    emailSubject: "Order marked as shipped",
    emailText: mpEmail(null, [`Your order was marked shipped. Tracking: ${tracking}`]),
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
  const { orders30dByProductIds } = await import("../services/admin-analytics.js");
  const rows = await prisma.product.findMany({
    include: {
      store: { include: { user: { select: userSelect } } },
      category: true,
      variants: { select: { sku: true }, orderBy: { createdAt: "asc" }, take: 5 },
      reviews: { select: { rating: true }, orderBy: { createdAt: "desc" }, take: 5 },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const orders30d = await orders30dByProductIds(rows.map((r) => r.id));
  const enriched = rows.map((row) => ({
    ...row,
    orders30d: orders30d.get(row.id) ?? 0,
  }));
  return ok(res, serialize(enriched));
});

adminRouter.get("/products/:id", async (req, res) => {
  const row = await prisma.product.findUnique({
    where: { id: param(req, "id") },
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
      status: z.enum(["APPROVED", "HIDDEN", "REJECTED", "PENDING", "REPORTED"]).optional(),
      active: z.boolean().optional(),
      flagReason: z.string().optional().nullable(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "status or active required");
  if (body.data.status === undefined && body.data.active === undefined) {
    return fail(res, 400, "VALIDATION", "status or active required");
  }

  const existing = await prisma.product.findUnique({ where: { id: param(req, "id") } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Product not found");

  let active = existing.active;
  let moderationStatus = existing.moderationStatus;
  if (body.data.active !== undefined) active = body.data.active;
  else if (body.data.status === "APPROVED") {
    active = true;
    moderationStatus = "ACTIVE";
  } else if (body.data.status === "PENDING") {
    active = false;
    moderationStatus = "PENDING";
  } else if (body.data.status === "REPORTED") {
    active = false;
    moderationStatus = "REPORTED";
  } else if (body.data.status === "HIDDEN") {
    active = false;
    moderationStatus = "HIDDEN";
  } else if (body.data.status === "REJECTED") {
    active = false;
    moderationStatus = "REJECTED";
  }

  const row = await prisma.product.update({
    where: { id: param(req, "id") },
    data: {
      active,
      moderationStatus,
      ...(body.data.flagReason !== undefined ? { flagReason: body.data.flagReason } : {}),
    },
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
  const statusLabel = body.data.status ?? moderationStatus;
  notifyUser(row.store.userId, {
    title: `Product ${String(statusLabel).toLowerCase()}`,
    body: row.title,
    href: `/seller/products/${row.id}`,
    emailPref: "emailEscrow",
    emailSubject: `Product ${String(statusLabel).toLowerCase()}`,
    emailText: mpEmail(null, [`Your product "${row.title}" was ${String(statusLabel).toLowerCase()}.`]),
  });
  return ok(res, serialize(row));
});

const adminProductPatchSchema = z.object({
  title: z.string().min(2).optional(),
  description: z.string().optional().nullable(),
  priceMinor: z.union([z.string(), z.number()]).optional(),
  moq: z.string().optional(),
  categoryId: z.string().uuid().optional().nullable(),
  active: z.boolean().optional(),
  stock: z.number().int().nonnegative().optional().nullable(),
  cbmPerUnit: z.number().positive().optional().nullable(),
  weightKgPerUnit: z.number().positive().optional().nullable(),
  originHub: z.string().min(1).optional().nullable(),
  leadTimeMin: z.number().int().nonnegative().optional().nullable(),
  leadTimeMax: z.number().int().nonnegative().optional().nullable(),
  packagingType: z.string().min(1).optional().nullable(),
  defaultIncoterm: z.string().min(2).optional().nullable(),
  parcelTypeId: z.string().uuid().optional().nullable(),
  imageUrl: z.string().min(1).optional().nullable(),
  mediaUrls: z.array(z.string().min(1)).optional(),
  moderationStatus: z.enum(["ACTIVE", "PENDING", "REPORTED", "HIDDEN", "REJECTED"]).optional(),
  flagReason: z.string().optional().nullable(),
});

function activeFromModerationStatus(status: string) {
  return status === "ACTIVE";
}

adminRouter.patch("/products/:id", async (req, res) => {
  const existing = await prisma.product.findUnique({ where: { id: param(req, "id") } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Product not found");
  const body = adminProductPatchSchema.safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid product fields");

  const moderationStatus = body.data.moderationStatus;
  const active =
    moderationStatus !== undefined
      ? activeFromModerationStatus(moderationStatus)
      : body.data.active;

  const row = await prisma.$transaction(async (tx) => {
    const p = await tx.product.update({
      where: { id: existing.id },
      data: {
        ...(body.data.title !== undefined ? { title: body.data.title } : {}),
        ...(body.data.description !== undefined ? { description: body.data.description } : {}),
        ...(body.data.priceMinor !== undefined ? { priceMinor: BigInt(body.data.priceMinor) } : {}),
        ...(body.data.moq !== undefined ? { moq: body.data.moq } : {}),
        ...(body.data.categoryId !== undefined ? { categoryId: body.data.categoryId } : {}),
        ...(active !== undefined ? { active } : {}),
        ...(body.data.stock !== undefined ? { stock: body.data.stock } : {}),
        ...(body.data.cbmPerUnit !== undefined ? { cbmPerUnit: body.data.cbmPerUnit } : {}),
        ...(body.data.weightKgPerUnit !== undefined ? { weightKgPerUnit: body.data.weightKgPerUnit } : {}),
        ...(body.data.originHub !== undefined ? { originHub: body.data.originHub } : {}),
        ...(body.data.leadTimeMin !== undefined ? { leadTimeMin: body.data.leadTimeMin } : {}),
        ...(body.data.leadTimeMax !== undefined ? { leadTimeMax: body.data.leadTimeMax } : {}),
        ...(body.data.packagingType !== undefined ? { packagingType: body.data.packagingType } : {}),
        ...(body.data.defaultIncoterm !== undefined ? { defaultIncoterm: body.data.defaultIncoterm } : {}),
        ...(body.data.parcelTypeId !== undefined ? { parcelTypeId: body.data.parcelTypeId } : {}),
        ...(body.data.imageUrl !== undefined ? { imageUrl: body.data.imageUrl } : {}),
        ...(moderationStatus !== undefined ? { moderationStatus } : {}),
        ...(body.data.flagReason !== undefined ? { flagReason: body.data.flagReason } : {}),
      },
    });

    if (body.data.mediaUrls) {
      await tx.productMedia.deleteMany({ where: { productId: p.id } });
      for (let i = 0; i < body.data.mediaUrls.length; i++) {
        await tx.productMedia.create({
          data: { productId: p.id, url: body.data.mediaUrls[i], sortOrder: i },
        });
      }
      if (body.data.imageUrl === undefined && body.data.mediaUrls[0]) {
        await tx.product.update({ where: { id: p.id }, data: { imageUrl: body.data.mediaUrls[0] } });
      }
    }

    return tx.product.findUnique({
      where: { id: p.id },
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
  });

  if (!row) return fail(res, 404, "NOT_FOUND", "Product not found");
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "product.update",
      entity: "Product",
      entityId: row.id,
      meta: { fields: Object.keys(body.data) },
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

  const existing = await prisma.category.findUnique({ where: { id: param(req, "id") } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Category not found");

  const row = await prisma.category.update({
    where: { id: param(req, "id") },
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
  const { listAdminSellersWithMetrics } = await import("../services/admin-analytics.js");
  const data = await listAdminSellersWithMetrics();
  return ok(res, serialize(data));
});

adminRouter.get("/sellers/:id", async (req, res) => {
  const row = await prisma.sellerStore.findUnique({
    where: { id: param(req, "id") },
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

  const existing = await prisma.sellerStore.findUnique({ where: { id: param(req, "id") } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Seller store not found");

  const row = await prisma.sellerStore.update({
    where: { id: param(req, "id") },
    data: body.data,
    include: {
      user: { select: userSelect },
      products: { orderBy: { createdAt: "desc" }, take: 50 },
      _count: { select: { products: true, members: true } },
    },
  });
  if (body.data.verified === true && !existing.verified) {
    await activatePendingSellerProducts(existing.userId);
  }
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
    where: { id: param(req, "id") },
    include: {
      milestones: { orderBy: { sortOrder: "asc" } },
      disputes: { include: { openedBy: { select: userSelect } } },
      documents: true,
      buyer: { select: userSelect },
      seller: { select: userSelect },
      inspections: {
        orderBy: { createdAt: "desc" },
        include: { inspector: true },
        take: 1,
      },
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Escrow not found");

  const order = await prisma.marketOrder.findFirst({
    where: { escrowId: row.id },
    include: {
      items: {
        include: {
          product: { select: { id: true, title: true, imageUrl: true } },
        },
      },
    },
  });

  const fxRow = await prisma.fxRate.findUnique({ where: { pair: "CNY_NGN" } });

  return ok(
    res,
    serialize({
      ...row,
      order,
      fxCnyNgn: fxRow ? Number(fxRow.rate) : 229.04,
    }),
  );
});

adminRouter.post("/escrows/:id/milestones/:msId/release", async (req, res) => {
  const escrow = await prisma.escrow.findUnique({
    where: { id: param(req, "id") },
    include: { milestones: true },
  });
  if (!escrow?.sellerId) return fail(res, 404, "NOT_FOUND", "Escrow not found");
  const msId = param(req, "msId");
  const ms = escrow.milestones.find((m) => m.id === msId);
  if (!ms || ms.status === "RELEASED" || ms.status === "DISPUTED") {
    return fail(res, 400, "BAD_STATE", "Milestone not releasable");
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (ms.status === "PENDING") {
        await tx.escrowMilestone.update({ where: { id: ms.id }, data: { status: "FUNDED" } });
      }
      await settleEscrowRelease(
        tx,
        escrow.buyerId,
        escrow.sellerId!,
        escrow.currency,
        ms.amountMinor,
        `Admin release ${ms.label}`,
        ms.id,
      );
      await tx.escrowMilestone.update({ where: { id: ms.id }, data: { status: "RELEASED" } });
      const remaining = await tx.escrowMilestone.count({
        where: { escrowId: escrow.id, status: { not: "RELEASED" } },
      });
      await recordTx(tx, {
        userId: escrow.sellerId!,
        kind: "escrow_release",
        title: escrow.title,
        subtitle: ms.label,
        currency: escrow.currency,
        amountDisplay: `+${formatMoney(escrow.currency, ms.amountMinor)}`,
        amountPositive: true,
        icon: "shield-check",
      });
      return tx.escrow.update({
        where: { id: escrow.id },
        data: {
          status: remaining === 0 ? "COMPLETED" : "ACTIVE",
          progress: remaining === 0 ? 1 : 0.75,
        },
        include: { milestones: { orderBy: { sortOrder: "asc" } } },
      });
    });

    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: "escrow.milestone.release",
        entity: "EscrowMilestone",
        entityId: msId,
        meta: { escrowId: escrow.id, label: ms.label },
      },
    });

    if (updated.status === "COMPLETED") {
      await prisma.marketOrder.updateMany({
        where: { escrowId: escrow.id, status: { in: ["IN_ESCROW", "SHIPPED", "DELIVERED"] } },
        data: { status: "COMPLETED" },
      });
    }

    notifyUsers([escrow.buyerId, escrow.sellerId!], {
      title: updated.status === "COMPLETED" ? "Escrow completed" : "Milestone released",
      body: `${ms.label} was released by MagnetPay ops.`,
      href: `/escrow/${escrow.id}`,
      emailPref: "emailEscrow",
      emailSubject: "Escrow milestone released",
      emailText: mpEmail(null, [`Milestone "${ms.label}" on escrow "${escrow.title}" was released by admin.`]),
    });

    return ok(res, serialize(updated));
  } catch (e) {
    return fail(res, 400, "RELEASE_FAILED", e instanceof Error ? e.message : "Release failed");
  }
});

adminRouter.get("/inspections", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const rows = await prisma.inspectionRequest.findMany({
    where: status ? { status: status as never } : { status: { not: "WAIVED" } },
    include: {
      inspector: true,
      escrow: {
        include: {
          buyer: { select: userSelect },
          seller: { select: userSelect },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return ok(res, serialize(rows));
});

adminRouter.patch("/inspections/:id", async (req, res) => {
  const body = z
    .object({
      status: z.enum(["REQUESTED", "SCHEDULED", "IN_PROGRESS", "PASSED", "FAILED"]).optional(),
      reportUrl: z.string().url().optional().or(z.literal("")),
      failedReason: z.string().max(500).optional(),
      assignedToId: z.string().uuid().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid inspection update");

  const existing = await prisma.inspectionRequest.findUnique({
    where: { id: param(req, "id") },
    include: { escrow: true, inspector: true },
  });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Inspection not found");

  const passedAt =
    body.data.status === "PASSED" ? new Date() : body.data.status === "FAILED" ? null : existing.passedAt;

  const updated = await prisma.inspectionRequest.update({
    where: { id: existing.id },
    data: {
      status: body.data.status,
      reportUrl: body.data.reportUrl === "" ? null : body.data.reportUrl,
      failedReason: body.data.failedReason,
      assignedToId: body.data.assignedToId,
      passedAt,
    },
    include: {
      inspector: true,
      escrow: {
        include: {
          buyer: { select: userSelect },
          seller: { select: userSelect },
        },
      },
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "inspection.update",
      entity: "InspectionRequest",
      entityId: updated.id,
      meta: { status: updated.status, escrowId: updated.escrowId },
    },
  });

  const partyIds = [updated.escrow.buyerId, updated.escrow.sellerId].filter(Boolean) as string[];
  if (updated.status === "PASSED") {
    notifyUsers(partyIds, {
      title: "Inspection passed",
      body: `"${updated.escrow.title}" — ${updated.inspector.name} report approved.`,
      href: `/escrow/${updated.escrowId}`,
      emailPref: "emailEscrow",
      emailSubject: "Escrow inspection passed",
      emailText: mpEmail(null, [
        `Inspection passed for escrow "${updated.escrow.title}".`,
        updated.reportUrl ? `Report: ${updated.reportUrl}` : "",
        updated.escrow.autoReleaseHours
          ? `Buyer has ${updated.escrow.autoReleaseHours}h to dispute before auto-release eligibility.`
          : "",
      ]),
    });
  } else if (updated.status === "FAILED") {
    notifyUsers(partyIds, {
      title: "Inspection failed",
      body: updated.failedReason ?? `"${updated.escrow.title}" did not pass inspection.`,
      href: `/escrow/${updated.escrowId}/dispute`,
      emailPref: "emailEscrow",
      emailSubject: "Escrow inspection failed",
      emailText: mpEmail(null, [
        `Inspection failed for escrow "${updated.escrow.title}".`,
        updated.failedReason ?? "Contact support or raise a dispute.",
      ]),
    });
  }

  return ok(res, serialize(updated));
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
    where: { id: param(req, "id") },
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
  await ensureDefaultFxFeeConfig();
  let rows = await prisma.feeConfig.findMany({
    where: { key: { startsWith: "fx." } },
    orderBy: { key: "asc" },
  });
  if (!rows.some((r) => feeConfigKeyToPair(r.key))) {
    await syncFxTableToFeeConfig();
    rows = await prisma.feeConfig.findMany({
      where: { key: { startsWith: "fx." } },
      orderBy: { key: "asc" },
    });
  }
  return ok(res, serialize(rows));
});

adminRouter.get("/fx/pairs", async (_req, res) => {
  const pairs = await listAdminFxPairs();
  const halted = await prisma.feeConfig.findUnique({ where: { key: "fx.halted" } });
  return ok(res, serialize({ pairs, halted: halted?.value === 1 }));
});

adminRouter.post("/fx/refresh", async (req, res) => {
  const synced = await syncFeeConfigRatesToFxTable();
  await prisma.fxRate.updateMany({ data: { updatedAt: new Date() } });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "fx.refresh",
      entity: "FxRate",
      meta: { synced },
    },
  });
  const pairs = await listAdminFxPairs();
  return ok(res, serialize({ pairs, synced }));
});

adminRouter.patch("/fx/pairs/:pairKey", async (req, res) => {
  const pairKey = param(req, "pairKey").toUpperCase().replace(/\//g, "_");
  const body = z
    .object({
      mid: z.number().positive().optional(),
      spreadBps: z.number().int().min(0).max(1000).optional(),
      override: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid pair update");

  const existing = await prisma.fxRate.findUnique({ where: { pair: pairKey } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "FX pair not found");

  if (body.data.mid !== undefined) {
    await prisma.fxRate.update({
      where: { pair: pairKey },
      data: { rate: body.data.mid },
    });
    await prisma.feeConfig.upsert({
      where: { key: `fx.${pairKey}` },
      create: { key: `fx.${pairKey}`, value: rateToFeeConfigValue(body.data.mid) },
      update: { value: rateToFeeConfigValue(body.data.mid) },
    });
  }
  if (body.data.spreadBps !== undefined) {
    await prisma.fxRate.update({
      where: { pair: pairKey },
      data: { spreadBps: body.data.spreadBps },
    });
  }
  if (body.data.override !== undefined) {
    const manualKey = `fx.manual.${pairKey}`;
    if (body.data.override) {
      await prisma.feeConfig.upsert({
        where: { key: manualKey },
        create: { key: manualKey, value: 1 },
        update: { value: 1 },
      });
    } else {
      await prisma.feeConfig.deleteMany({ where: { key: manualKey } });
    }
  }

  await syncFeeConfigRatesToFxTable();
  const pairs = await listAdminFxPairs();
  const updated = pairs.find((p) => p.pairKey === pairKey);
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: "fx.pair.update",
      entity: "FxRate",
      meta: { pairKey, ...body.data },
    },
  });
  return ok(res, serialize(updated ?? null));
});

adminRouter.post("/fx/halt", async (req, res) => {
  const body = z.object({ halted: z.boolean() }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "halted boolean required");
  await prisma.feeConfig.upsert({
    where: { key: "fx.halted" },
    create: { key: "fx.halted", value: body.data.halted ? 1 : 0 },
    update: { value: body.data.halted ? 1 : 0 },
  });
  await prisma.auditLog.create({
    data: {
      actorId: req.user!.id,
      action: body.data.halted ? "fx.halt" : "fx.resume",
      entity: "FeeConfig",
      meta: { halted: body.data.halted },
    },
  });
  return ok(res, serialize({ halted: body.data.halted }));
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
  const synced = await syncFeeConfigRatesToFxTable();
  return ok(res, serialize({ updated, synced }));
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
  notifyUser(req.user!.id, {
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

  const byId = await prisma.feeConfig.findUnique({ where: { id: param(req, "id") } });
  if (byId) {
    const row = await prisma.feeConfig.update({
      where: { id: param(req, "id") },
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
  const key = body.data.key ?? param(req, "id");
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
      originHubs: z.array(originHubSchema).optional(),
      packagingTypes: z.array(packagingTypeSchema).optional(),
      productSeaLclCnyPerCbm: z.number().int().positive().optional(),
      productDefaultDestination: z.string().min(2).optional(),
      productSeaTransitLabel: z.string().min(2).optional(),
      productEstimateModeLabel: z.string().min(2).optional(),
      productEstimateFootnote: z.string().min(5).optional().nullable(),
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

  const existing = await prisma.parcelType.findUnique({ where: { id: param(req, "id") } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Parcel type not found");

  const row = await prisma.parcelType.update({ where: { id: param(req, "id") }, data: body.data });
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
    where: { id: param(req, "id") },
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

  const existing = await prisma.logisticsPartner.findUnique({ where: { id: param(req, "id") } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Partner not found");

  const row = await prisma.logisticsPartner.update({
    where: { id: param(req, "id") },
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
  const partner = await prisma.logisticsPartner.findUnique({ where: { id: param(req, "id") } });
  if (!partner) return fail(res, 404, "NOT_FOUND", "Partner not found");
  const rows = await prisma.logisticsPartnerRate.findMany({
    where: { partnerId: partner.id },
    include: { parcelType: { select: { id: true, code: true, name: true } } },
    orderBy: [{ sortOrder: "asc" }, { mode: "asc" }],
  });
  return ok(res, serialize(rows));
});

adminRouter.post("/logistics/partners/:id/rates", async (req, res) => {
  const partner = await prisma.logisticsPartner.findUnique({ where: { id: param(req, "id") } });
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
    where: { id: param(req, "rateId"), partnerId: param(req, "partnerId") },
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
    where: { id: param(req, "rateId"), partnerId: param(req, "partnerId") },
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
      shipmentId: param(req, "id"),
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
      shipmentId: param(req, "id"),
      finalMinor: body.data.finalMinor != null ? BigInt(body.data.finalMinor) : undefined,
      breakdown: body.data.breakdown,
      notes: body.data.notes,
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: "shipment.settle",
        entity: "Shipment",
        entityId: param(req, "id"),
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
    where: { id: param(req, "id") },
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
      shipmentId: param(req, "id"),
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
        meta: { shipmentId: param(req, "id"), kind: body.data.kind, name: body.data.name },
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
    await removeShipmentDocument({ shipmentId: param(req, "id"), documentId: param(req, "docId") });
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: "shipment.document.remove",
        entity: "ShipmentDocument",
        entityId: param(req, "docId"),
        meta: { shipmentId: param(req, "id") },
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
  const row = await getAdminRecord(param(req, "id"));
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
  const existing = await getAdminRecord(param(req, "id"));
  if (!existing) return fail(res, 404, "NOT_FOUND", "Record not found");
  const row = await patchAdminRecord(param(req, "id"), body.data);
  return ok(res, serialize(row));
});

registerAdminExtensions(adminRouter);
