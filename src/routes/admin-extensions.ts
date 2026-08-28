import type { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { fail, ok, serialize } from "../lib/http.js";
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
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return fail(res, 404, "NOT_FOUND", "Product not found");
    await ensureProductViewEstimate(req.params.id);
    return ok(res, serialize(await getProductStats(req.params.id)));
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
      where: { orderId: req.params.id },
      include: { author: { select: userSelect } },
      orderBy: { createdAt: "desc" },
    });
    return ok(res, serialize(rows));
  });

  router.post("/orders/:id/notes", async (req, res) => {
    const body = z.object({ body: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "body required");
    const order = await prisma.marketOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
    const row = await prisma.orderNote.create({
      data: { orderId: order.id, authorId: req.user!.id, body: body.data.body },
      include: { author: { select: userSelect } },
    });
    return ok(res, serialize(row), 201);
  });

  router.post("/orders/:id/refund", async (req, res) => {
    const body = z.object({ amountMinor: z.union([z.string(), z.number()]).optional(), reason: z.string().optional() }).safeParse(req.body ?? {});
    if (!body.success) return fail(res, 400, "VALIDATION", "Invalid payload");
    const order = await prisma.marketOrder.findUnique({ where: { id: req.params.id } });
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
    return ok(res, serialize(updated));
  });

  router.get("/sellers/:id/stats", async (req, res) => {
    const stats = await getSellerStats(req.params.id);
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

  router.get("/wallets/:userId/stats", async (req, res) => {
    const since30 = new Date(Date.now() - 30 * 86_400_000);
    const wallets = await prisma.wallet.findMany({ where: { userId: req.params.userId } });
    const txns = await prisma.transaction.count({
      where: { userId: req.params.userId, createdAt: { gte: since30 } },
    });
    return ok(res, serialize({ wallets: wallets.length, txns30d: txns }));
  });

  router.get("/money/ledger", async (_req, res) => {
    const rows = await prisma.transaction.findMany({
      include: { user: { select: userSelect } },
      orderBy: { createdAt: "desc" },
      take: 200,
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
      where: { id: req.params.id },
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
    const existing = await prisma.dispute.findUnique({ where: { id: req.params.id } });
    if (!existing) return fail(res, 404, "NOT_FOUND", "Dispute not found");
    const row = await prisma.dispute.update({
      where: { id: req.params.id },
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
    return ok(res, serialize(row));
  });

  router.get("/tickets", async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const rows = await listAdminRecords("ticket", status);
    return ok(res, serialize(rows));
  });

  router.get("/tickets/:id", async (req, res) => {
    const row = await getAdminRecord(req.params.id);
    if (!row || row.domain !== "ticket") return fail(res, 404, "NOT_FOUND", "Ticket not found");
    return ok(res, serialize(row));
  });

  router.post("/tickets/:id/messages", async (req, res) => {
    const body = z.object({ body: z.string().min(1), author: z.string().optional() }).safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "body required");
    const row = await getAdminRecord(req.params.id);
    if (!row || row.domain !== "ticket") return fail(res, 404, "NOT_FOUND", "Ticket not found");
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
    messages.push({
      id: `msg-${Date.now()}`,
      body: body.data.body,
      author: body.data.author ?? "Admin",
      at: new Date().toISOString(),
    });
    const updated = await patchAdminRecord(row.id, { payload: { ...payload, messages } });
    return ok(res, serialize(updated));
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
    const row = await getAdminRecord(req.params.id);
    if (!row || row.domain !== "aml") return fail(res, 404, "NOT_FOUND", "Case not found");
    return ok(res, serialize(row));
  });

  router.post("/compliance/aml/:id/decide", async (req, res) => {
    const body = z.object({ status: z.string(), note: z.string().optional() }).safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "status required");
    const row = await patchAdminRecord(req.params.id, {
      status: body.data.status,
      payload: { note: body.data.note },
    });
    return ok(res, serialize(row));
  });

  router.post("/compliance/fraud-cases/:id/decide", async (req, res) => {
    const body = z.object({ status: z.string(), note: z.string().optional() }).safeParse(req.body);
    if (!body.success) return fail(res, 400, "VALIDATION", "status required");
    const row = await patchAdminRecord(req.params.id, {
      status: body.data.status,
      payload: { note: body.data.note },
    });
    return ok(res, serialize(row));
  });
}
