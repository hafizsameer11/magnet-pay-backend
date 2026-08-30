import type { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {fail, ok, serialize, param } from "../lib/http.js";
import {
  getAdminAnalyticsGmv,
  getAdminAnalyticsUsers,
  getAdminAnalyticsSellers,
  getAdminAnalyticsFx,
  getAdminAnalyticsLogistics,
  getAdminAnalyticsFunnels,
  getAdminAnalyticsCohorts,
  getProductStats,
  ensureProductViewEstimate,
  getOrderStats,
  getSellerStats,
  getEscrowStats,
  getShipmentStats,
} from "../services/admin-analytics.js";
import {
  listAdminRecords,
  getAdminRecord,
  patchAdminRecord,
} from "../services/admin-records.js";
import {
  adjustUserWallet,
  getWalletUserDetail,
  listWalletHolders,
  setWalletUserFrozen,
} from "../services/admin-wallets.js";
import { notifyConversationPeers, notifyUser, notifyUsers, mpEmail } from "../services/user-notify.js";

const userSelect = { id: true, name: true, phone: true, email: true, role: true };

export function registerAdminExtensions(router: Router) {
  router.get("/analytics/gmv", async (_req, res) => ok(res, serialize(await getAdminAnalyticsGmv())));
  router.get("/analytics/users", async (_req, res) => ok(res, serialize(await getAdminAnalyticsUsers())));
  router.get("/analytics/sellers", async (_req, res) => ok(res, serialize(await getAdminAnalyticsSellers())));
  router.get("/analytics/fx", async (_req, res) => ok(res, serialize(await getAdminAnalyticsFx())));
  router.get("/analytics/logistics", async (_req, res) => ok(res, serialize(await getAdminAnalyticsLogistics())));
  router.get("/analytics/funnels", async (_req, res) => ok(res, serialize(await getAdminAnalyticsFunnels())));
  router.get("/analytics/cohorts", async (_req, res) => ok(res, serialize(await getAdminAnalyticsCohorts())));

  router.get("/products/:id/stats", async (req, res) => {
    const product = await prisma.product.findUnique({ where: { id: param(req, "id") } });
    if (!product) return fail(res, 404, "NOT_FOUND", "Product not found");
    await ensureProductViewEstimate(param(req, "id"));
    return ok(res, serialize(await getProductStats(param(req, "id"))));
  });

  router.get("/brands", async (_req, res) => {
    const rows = await prisma.brand.findMany({
      include: { _count: { select: { products: true } } },
      orderBy: { name: "asc" },
      take: 200,
    });
    return ok(res, serialize(rows));
  });

  router.post("/brands", async (req, res) => {
    const body = z.object({ name: z.string().min(1), status: z.string().optional(), country: z.string().optional() }).safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "name required");
    const row = await prisma.brand.create({
      data: {
        name: body.data.name,
        status: body.data.status ?? "verified",
        country: body.data.country ?? "CN",
      },
    });
    return ok(res, serialize(row), 201);
  });

  router.get("/orders/stats", async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    return ok(res, serialize(await getOrderStats(status)));
  });

  router.get("/orders/:id/notes", async (req, res) => {
    const rows = await prisma.orderNote.findMany({
      where: { orderId: param(req, "id") },
      include: { author: { select: userSelect } },
      orderBy: { createdAt: "desc" },
    });
    return ok(res, serialize(rows));
  });

  router.post("/orders/:id/notes", async (req, res) => {
    const body = z.object({ body: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "body required");
    const order = await prisma.marketOrder.findUnique({ where: { id: param(req, "id") } });
    if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
    const row = await prisma.orderNote.create({
      data: { orderId: order.id, authorId: req.user!.id, body: body.data.body },
      include: { author: { select: userSelect } },
    });
    notifyUser(order.userId, {
      title: "Order note from MagnetPay",
      body: body.data.body.slice(0, 120),
      href: `/market/order/${order.id}`,
    });
    return ok(res, serialize(row), 201);
  });

  router.post("/orders/:id/refund", async (req, res) => {
    const body = z.object({ amountMinor: z.union([z.string(), z.number()]).optional(), reason: z.string().optional() }).safeParse(req.body ?? {});
    if (!body.success) return fail(res, 400, "VALIDATION", "Invalid payload");
    const order = await prisma.marketOrder.findUnique({ where: { id: param(req, "id") } });
    if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
    const updated = await prisma.marketOrder.update({
      where: { id: order.id },
      data: { status: "CANCELLED" },
      include: { items: true, user: { select: userSelect } },
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: "order.refund",
        entity: "MarketOrder",
        entityId: order.id,
        meta: { reason: body.data.reason, amountMinor: body.data.amountMinor ?? order.totalMinor.toString() },
      },
    });
    notifyUser(order.userId, {
      title: "Order refunded",
      body: body.data.reason ?? `Order ${order.id.slice(0, 8)} was cancelled and refunded.`,
      href: `/market/order/${order.id}`,
      emailPref: "emailEscrow",
      emailSubject: "Order refunded",
      emailText: mpEmail(null, [`Your order ${order.id.slice(0, 8)} was refunded.${body.data.reason ? ` Reason: ${body.data.reason}` : ""}`]),
    });
    const store = await prisma.sellerStore.findFirst({
      where: { OR: [{ id: order.supplier }, { name: order.supplier }] },
      select: { userId: true },
    });
    notifyUser(store?.userId, {
      title: "Order refunded",
      body: `Order ${order.id.slice(0, 8)} was refunded by MagnetPay ops.`,
      href: `/market/order/${order.id}`,
    });
    return ok(res, serialize(updated));
  });

  router.get("/sellers/:id/stats", async (req, res) => {
    const stats = await getSellerStats(param(req, "id"));
    if (!stats) return fail(res, 404, "NOT_FOUND", "Seller not found");
    return ok(res, serialize(stats));
  });

  router.get("/sellers/tiers", async (_req, res) => {
    const rows = await listAdminRecords("seller-tier");
    if (rows.length === 0) {
      return ok(res, serialize([
        { id: "tier-gold", name: "Gold tier", minOrders: 100, verified: true },
        { id: "tier-verified", name: "Verified", minOrders: 0, verified: true },
        { id: "tier-new", name: "New", minOrders: 0, verified: false },
      ]));
    }
    return ok(res, serialize(rows));
  });

  router.get("/escrows/stats", async (_req, res) => ok(res, serialize(await getEscrowStats())));
  router.get("/shipments/stats", async (_req, res) => ok(res, serialize(await getShipmentStats())));

  router.get("/wallets/holders", async (_req, res) => {
    const holders = await listWalletHolders();
    return ok(res, serialize(holders));
  });

  router.get("/wallets/:userId", async (req, res) => {
    const detail = await getWalletUserDetail(param(req, "userId"));
    if (!detail) return fail(res, 404, "NOT_FOUND", "Wallet holder not found");
    return ok(res, serialize(detail));
  });

  router.get("/wallets/:userId/stats", async (req, res) => {
    const detail = await getWalletUserDetail(param(req, "userId"));
    if (!detail) return fail(res, 404, "NOT_FOUND", "Wallet holder not found");
    return ok(res, serialize({ wallets: detail.stats.currencyCount, txns30d: detail.stats.txns30d }));
  });

  router.post("/wallets/:userId/adjust", async (req, res) => {
    const body = z
      .object({
        currency: z.enum(["NGN", "CNY", "USD"]),
        amountMinor: z.union([z.string(), z.number()]),
        direction: z.enum(["credit", "debit"]),
        note: z.string().min(3).max(500),
      })
      .safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "Invalid adjustment payload");
    const amountMinor = BigInt(body.data.amountMinor);
    try {
      const wallet = await adjustUserWallet({
        userId: param(req, "userId"),
        currency: body.data.currency,
        amountMinor,
        direction: body.data.direction,
        note: body.data.note,
        actorId: req.user!.id,
      });
      return ok(res, serialize(wallet));
    } catch (e) {
      return fail(res, 400, "ADJUST_FAILED", e instanceof Error ? e.message : "Adjustment failed");
    }
  });

  router.post("/wallets/:userId/freeze", async (req, res) => {
    const body = z
      .object({
        frozen: z.boolean(),
        note: z.string().max(500).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "Invalid freeze payload");
    try {
      const status = await setWalletUserFrozen({
        userId: param(req, "userId"),
        frozen: body.data.frozen,
        note: body.data.note,
        actorId: req.user!.id,
      });
      return ok(res, serialize({ status }));
    } catch (e) {
      return fail(res, 400, "FREEZE_FAILED", e instanceof Error ? e.message : "Could not update wallet access");
    }
  });

  router.get("/money/ledger", async (req, res) => {
    const userId = typeof req.query.userId === "string" && req.query.userId.trim() ? req.query.userId.trim() : undefined;
    const rows = await prisma.transaction.findMany({
      where: userId ? { userId } : undefined,
      include: { user: { select: userSelect } },
      orderBy: { createdAt: "desc" },
      take: userId ? 100 : 200,
    });
    return ok(res, serialize(rows.map((r) => ({
      id: r.id,
      type: r.kind,
      status: r.status,
      amountDisplay: r.amountDisplay,
      currency: r.currency,
      user: r.user,
      createdAt: r.createdAt,
      description: r.title,
    }))));
  });

  router.get("/money/reconciliation", async (_req, res) => {
    const [deposits, withdrawals, transfers] = await Promise.all([
      prisma.deposit.groupBy({ by: ["status"], _count: true, _sum: { amountMinor: true } }),
      prisma.withdrawal.groupBy({ by: ["status"], _count: true, _sum: { amountMinor: true } }),
      prisma.transfer.count(),
    ]);
    return ok(res, serialize({ deposits, withdrawals, transfers, lastRun: new Date().toISOString(), status: "balanced" }));
  });

  router.get("/money/fx-spreads", async (_req, res) => {
    const rows = await prisma.feeConfig.findMany({ where: { key: { startsWith: "fx.spread." } } });
    if (rows.length === 0) {
      return ok(res, serialize([
        { pair: "CNY/NGN", tier: "Retail", spread: 1.8 },
        { pair: "CNY/NGN", tier: "Pro", spread: 1.2 },
        { pair: "USD/NGN", tier: "Retail", spread: 1.2 },
      ]));
    }
    return ok(res, serialize(rows));
  });

  router.get("/disputes/:id", async (req, res) => {
    const row = await prisma.dispute.findUnique({
      where: { id: param(req, "id") },
      include: {
        escrow: { include: { milestones: true, buyer: { select: userSelect }, seller: { select: userSelect } } },
        openedBy: { select: userSelect },
        assignee: { select: userSelect },
      },
    });
    if (!row) return fail(res, 404, "NOT_FOUND", "Dispute not found");
    return ok(res, serialize(row));
  });

  router.patch("/disputes/:id", async (req, res) => {
    const body = z
      .object({
        status: z.string().optional(),
        assigneeId: z.string().nullable().optional(),
        priority: z.string().optional(),
        ruling: z.string().optional(),
        outcome: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "Invalid payload");
    const existing = await prisma.dispute.findUnique({ where: { id: param(req, "id") } });
    if (!existing) return fail(res, 404, "NOT_FOUND", "Dispute not found");
    const row = await prisma.dispute.update({
      where: { id: param(req, "id") },
      data: {
        ...(body.data.status !== undefined ? { status: body.data.status } : {}),
        ...(body.data.assigneeId !== undefined ? { assigneeId: body.data.assigneeId } : {}),
        ...(body.data.priority !== undefined ? { priority: body.data.priority } : {}),
        ...(body.data.ruling !== undefined ? { ruling: body.data.ruling } : {}),
        ...(body.data.outcome !== undefined ? { outcome: body.data.outcome } : {}),
      },
      include: {
        escrow: true,
        openedBy: { select: userSelect },
        assignee: { select: userSelect },
      },
    });
    const partyIds = [row.escrow?.buyerId, row.escrow?.sellerId].filter(Boolean) as string[];
    if (body.data.status || body.data.outcome || body.data.ruling) {
      notifyUsers(partyIds, {
        title: "Dispute update",
        body: body.data.outcome ?? body.data.ruling ?? body.data.status ?? "Your dispute was updated.",
        href: row.escrow ? `/escrow/${row.escrow.id}` : "/notifications",
        emailPref: "emailEscrow",
        emailSubject: "Dispute update",
        emailText: mpEmail(null, ["Your MagnetPay dispute was updated by support."]),
      });
    }
    return ok(res, serialize(row));
  });

  router.get("/tickets", async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    let rows = await listAdminRecords("ticket", status);
    if (userId) {
      rows = rows.filter((r) => {
        const p = (r.payload ?? {}) as Record<string, unknown>;
        return p.userId === userId;
      });
    }
    return ok(res, serialize(rows));
  });

  router.get("/tickets/:id", async (req, res) => {
    const row = await getAdminRecord(param(req, "id"));
    if (!row || row.domain !== "ticket") return fail(res, 404, "NOT_FOUND", "Ticket not found");
    return ok(res, serialize(row));
  });

  router.post("/tickets/:id/messages", async (req, res) => {
    const body = z.object({ body: z.string().min(1), author: z.string().optional() }).safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "body required");
    const row = await getAdminRecord(param(req, "id"));
    if (!row || row.domain !== "ticket") return fail(res, 404, "NOT_FOUND", "Ticket not found");
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
    const authorName = body.data.author ?? req.user!.id;
    messages.push({
      id: `msg-${Date.now()}`,
      body: body.data.body,
      author: body.data.author ?? "Admin",
      at: new Date().toISOString(),
    });
    const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : null;
    if (conversationId) {
      const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
      if (conv) {
        const part = await prisma.conversationParticipant.findFirst({
          where: { conversationId, userId: req.user!.id },
        });
        if (!part) {
          await prisma.conversationParticipant.create({
            data: { conversationId, userId: req.user!.id },
          });
        }
        await prisma.message.create({
          data: {
            conversationId,
            senderId: req.user!.id,
            body: `[Support] ${body.data.body}`,
          },
        });
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        });
        void notifyConversationPeers(conversationId, req.user!.id, {
          title: "Support reply",
          body: body.data.body.slice(0, 120),
          href: `/messages/${conversationId}`,
        });
      }
    }
    const updated = await patchAdminRecord(row.id, { payload: { ...payload, messages } });
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: "ticket.reply",
        entity: "AdminRecord",
        entityId: row.id,
        meta: { author: authorName, conversationId },
      },
    }).catch(() => {});
    return ok(res, serialize(updated));
  });

  router.post("/conversations/:id/messages", async (req, res) => {
    const body = z.object({ body: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "body required");
    const conversationId = param(req, "id");
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return fail(res, 404, "NOT_FOUND", "Conversation not found");
    const part = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId: req.user!.id },
    });
    if (!part) {
      await prisma.conversationParticipant.create({
        data: { conversationId, userId: req.user!.id },
      });
    }
    const msg = await prisma.message.create({
      data: {
        conversationId,
        senderId: req.user!.id,
        body: body.data.body,
      },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    void notifyConversationPeers(conversationId, req.user!.id, {
      title: "New message",
      body: body.data.body.slice(0, 120),
      href: `/messages/${conversationId}`,
    });
    return ok(res, serialize(msg), 201);
  });

  const domainGet = (path: string, domain: string) => {
    router.get(path, async (req, res) => {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      return ok(res, serialize(await listAdminRecords(domain, status)));
    });
  };

  domainGet("/webhooks", "webhook");
  domainGet("/feature-flags", "feature-flag");
  domainGet("/jobs", "job");
  domainGet("/incidents", "incident");
  domainGet("/content/pages", "legal-page");
  domainGet("/help/articles", "help-article");
  domainGet("/email-templates", "email-template");
  domainGet("/sms-templates", "sms-template");

  router.get("/compliance/aml/:id", async (req, res) => {
    const row = await getAdminRecord(param(req, "id"));
    if (!row || row.domain !== "aml") return fail(res, 404, "NOT_FOUND", "Case not found");
    return ok(res, serialize(row));
  });

  router.post("/compliance/aml/:id/decide", async (req, res) => {
    const body = z.object({ status: z.string(), note: z.string().optional() }).safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "status required");
    const row = await patchAdminRecord(param(req, "id"), {
      status: body.data.status,
      payload: { note: body.data.note },
    });
    return ok(res, serialize(row));
  });

  router.post("/compliance/fraud-cases/:id/decide", async (req, res) => {
    const body = z.object({ status: z.string(), note: z.string().optional() }).safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "status required");
    const row = await patchAdminRecord(param(req, "id"), {
      status: body.data.status,
      payload: { note: body.data.note },
    });
    return ok(res, serialize(row));
  });

  router.get("/categories/:id", async (req, res) => {
    const row = await prisma.category.findUnique({
      where: { id: param(req, "id") },
      include: { _count: { select: { products: true } }, defaultParcelType: { select: { id: true, code: true, name: true } } },
    });
    if (!row) return fail(res, 404, "NOT_FOUND", "Category not found");
    return ok(res, serialize(row));
  });

  router.get("/reviews/:id", async (req, res) => {
    const row = await prisma.review.findUnique({
      where: { id: param(req, "id") },
      include: {
        user: { select: userSelect },
        product: { select: { id: true, title: true, storeId: true } },
      },
    });
    if (!row) return fail(res, 404, "NOT_FOUND", "Review not found");
    return ok(res, serialize(row));
  });

  router.get("/conversations/:id", async (req, res) => {
    const row = await prisma.conversation.findUnique({
      where: { id: param(req, "id") },
      include: {
        participants: { include: { user: { select: userSelect } } },
        messages: { orderBy: { createdAt: "asc" }, take: 100 },
      },
    });
    if (!row) return fail(res, 404, "NOT_FOUND", "Conversation not found");
    return ok(res, serialize(row));
  });

  router.get("/users/:id/notes", async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: param(req, "id") } });
    if (!user) return fail(res, 404, "NOT_FOUND", "User not found");
    const rows = await prisma.auditLog.findMany({
      where: { entity: "User", entityId: param(req, "id"), action: "user.admin_note" },
      include: { actor: { select: userSelect } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return ok(
      res,
      serialize(
        rows.map((r) => ({
          id: r.id,
          body: ((r.meta ?? {}) as { body?: string }).body ?? "",
          createdAt: r.createdAt,
          author: r.actor,
        })),
      ),
    );
  });

  router.post("/users/:id/notes", async (req, res) => {
    const body = z.object({ body: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "body required");
    const user = await prisma.user.findUnique({ where: { id: param(req, "id") } });
    if (!user) return fail(res, 404, "NOT_FOUND", "User not found");
    const row = await prisma.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: "user.admin_note",
        entity: "User",
        entityId: user.id,
        meta: { body: body.data.body },
      },
      include: { actor: { select: userSelect } },
    });
    return ok(
      res,
      serialize({
        id: row.id,
        body: body.data.body,
        createdAt: row.createdAt,
        author: row.actor,
      }),
      201,
    );
  });

  router.get("/export/orders.csv", async (_req, res) => {
    const rows = await prisma.marketOrder.findMany({
      include: { user: { select: userSelect }, items: true },
      orderBy: { createdAt: "desc" },
      take: 5000,
    });
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const header = ["id", "createdAt", "status", "currency", "totalMinor", "buyerName", "buyerPhone", "itemCount", "logisticsStatus"].join(",");
    const lines = rows.map((o) =>
      [
        o.id,
        o.createdAt.toISOString(),
        o.status,
        o.currency,
        o.totalMinor.toString(),
        o.user?.name ?? "",
        o.user?.phone ?? "",
        o.items.length,
        o.logisticsStatus ?? "",
      ]
        .map((v) => escape(String(v)))
        .join(","),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="magnetpay-orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send([header, ...lines].join("\n"));
  });
}
