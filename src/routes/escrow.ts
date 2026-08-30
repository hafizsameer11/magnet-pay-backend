import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import {fail, ok, requireAuth, serialize, param } from "../lib/http.js";
import {
  formatMoney,
  lockToHold,
  recordTx,
  settleEscrowRelease,
} from "../services/ledger.js";
import { fulfillmentForEscrow, releaseGate } from "../services/escrow-fulfillment.js";
import { mpEmail, notifyUser } from "../services/user-notify.js";

export const escrowRouter = Router();

escrowRouter.get("/meta/fee", requireAuth, async (req, res) => {
  const amountMinor = BigInt(String(req.query.amountMinor ?? "0"));
  const bps = 150;
  const feeMinor = (amountMinor * BigInt(bps)) / 10000n;
  return ok(res, { feeBps: bps, feeMinor: feeMinor.toString(), feePct: bps / 10000 });
});

escrowRouter.get("/meta/inspectors", requireAuth, async (_req, res) => {
  return ok(res, [
    { id: "sgs", name: "SGS", region: "Lagos · Guangzhou", feeMinor: "42000", rating: 4.9 },
    { id: "bv", name: "Bureau Veritas", region: "Apapa · Ningbo", feeMinor: "38000", rating: 4.8 },
    { id: "intertek", name: "Intertek", region: "Lagos · Shenzhen", feeMinor: "35000", rating: 4.7 },
    { id: "none", name: "Self-inspection", region: "Buyer arranges", feeMinor: "0", rating: 0 },
  ]);
});

escrowRouter.get("/meta/terms/:id", requireAuth, async (req, res) => {
  const id = String(param(req, "id"));
  const escrow = await prisma.escrow.findFirst({
    where: { id, OR: [{ buyerId: req.user!.id }, { sellerId: req.user!.id }] },
    include: { milestones: { orderBy: { sortOrder: "asc" } }, buyer: true, seller: true },
  });
  if (!escrow) return fail(res, 404, "NOT_FOUND", "Escrow not found");
  const lines = [
    `MagnetPay Escrow Terms · ${escrow.title}`,
    `Amount: ${escrow.amountMinor} ${escrow.currency}`,
    `Buyer: ${escrow.buyer.name}`,
    `Seller: ${escrow.seller?.name ?? "Pending"}`,
    ...escrow.milestones.map((m, i) => `Milestone ${i + 1}: ${m.label} · ${m.amountMinor}`),
  ];
  return ok(res, { text: lines.join("\n"), escrowId: escrow.id });
});

escrowRouter.get("/", requireAuth, async (req, res) => {
  const rows = await prisma.escrow.findMany({
    where: {
      OR: [{ buyerId: req.user!.id }, { sellerId: req.user!.id }],
    },
    include: { milestones: { orderBy: { sortOrder: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(rows));
});

escrowRouter.get("/invite/:token", requireAuth, async (req, res) => {
  const token = String(param(req, "token"));
  const invite = await prisma.escrowInvite.findUnique({
    where: { token },
    include: {
      escrow: {
        include: {
          milestones: { orderBy: { sortOrder: "asc" } },
          buyer: { select: { id: true, name: true, phone: true } },
        },
      },
    },
  });
  if (!invite || invite.expiresAt < new Date()) {
    return fail(res, 400, "INVALID_INVITE", "Invite invalid or expired");
  }
  return ok(res, serialize(invite));
});

escrowRouter.get("/:id", requireAuth, async (req, res) => {
  const id = String(param(req, "id"));
  const row = await prisma.escrow.findFirst({
    where: {
      id,
      OR: [{ buyerId: req.user!.id }, { sellerId: req.user!.id }],
    },
    include: {
      milestones: { orderBy: { sortOrder: "asc" } },
      documents: true,
      disputes: true,
      invites: true,
      buyer: { select: { id: true, name: true, phone: true } },
      seller: { select: { id: true, name: true, phone: true } },
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Escrow not found");
  const funded = row.milestones.find((m) => m.status === "FUNDED");
  const fulfillment = await fulfillmentForEscrow(row.id, funded);
  return ok(res, serialize({ ...row, fulfillment }));
});

escrowRouter.post("/", requireAuth, async (req, res) => {
  const body = z
    .object({
      title: z.string().min(2),
      amountMinor: z.union([z.string(), z.number()]),
      currency: z.enum(["NGN", "CNY", "USD"]).default("CNY"),
      sellerId: z.string().uuid().optional(),
      invitePhone: z.string().optional(),
      inspectorId: z.string().optional(),
      milestones: z
        .array(z.object({ label: z.string(), amountMinor: z.union([z.string(), z.number()]) }))
        .optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid escrow");
  const amountMinor = BigInt(body.data.amountMinor);
  const inviteToken = randomBytes(16).toString("hex");

  let sellerId = body.data.sellerId;
  if (!sellerId && body.data.invitePhone) {
    const match = await prisma.user.findFirst({
      where: { phone: body.data.invitePhone },
      select: { id: true },
    });
    if (match) sellerId = match.id;
  }

  const escrow = await prisma.$transaction(async (tx) => {
    const e = await tx.escrow.create({
      data: {
        title: body.data.title,
        buyerId: req.user!.id,
        sellerId,
        amountMinor,
        currency: body.data.currency,
        status: sellerId ? "AWAITING_FUNDS" : "AWAITING_SELLER",
        inviteToken,
        inspectorId: body.data.inspectorId || null,
      },
    });
    const ms =
      body.data.milestones?.length
        ? body.data.milestones
        : [{ label: "Full amount", amountMinor: amountMinor.toString() }];
    for (let i = 0; i < ms.length; i++) {
      await tx.escrowMilestone.create({
        data: {
          escrowId: e.id,
          label: ms[i].label,
          amountMinor: BigInt(ms[i].amountMinor),
          sortOrder: i,
        },
      });
    }
    if (body.data.invitePhone) {
      await tx.escrowInvite.create({
        data: {
          escrowId: e.id,
          phone: body.data.invitePhone,
          token: inviteToken,
          expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        },
      });
    }
    return tx.escrow.findUnique({
      where: { id: e.id },
      include: { milestones: true, invites: true },
    });
  });
  if (sellerId) {
    notifyUser(sellerId, {
      title: "New escrow deal",
      body: body.data.title,
      href: `/escrow/${escrow!.id}`,
      emailPref: "emailEscrow",
      emailSubject: "New escrow deal",
      emailText: mpEmail(null, [`You were added to escrow "${body.data.title}".`]),
    });
  } else if (body.data.invitePhone) {
    const invitee = await prisma.user.findFirst({
      where: { phone: body.data.invitePhone },
      select: { id: true },
    });
    notifyUser(invitee?.id, {
      title: "Escrow invite",
      body: body.data.title,
      href: `/escrow/invite/${inviteToken}`,
      emailPref: "emailEscrow",
      emailSubject: "Escrow invite",
      emailText: mpEmail(null, [`You were invited to escrow "${body.data.title}".`]),
    });
  }
  return ok(res, serialize(escrow), 201);
});

escrowRouter.post("/invite/:token/decline", requireAuth, async (req, res) => {
  const invite = await prisma.escrowInvite.findUnique({
    where: { token: param(req, "token") },
    include: { escrow: true },
  });
  if (!invite || invite.expiresAt < new Date()) {
    return fail(res, 400, "INVALID_INVITE", "Invite invalid or expired");
  }
  await prisma.$transaction(async (tx) => {
    await tx.escrow.update({
      where: { id: invite.escrowId },
      data: { status: "CANCELLED" },
    });
  });
  notifyUser(invite.escrow.buyerId, {
    title: "Invite declined",
    body: invite.escrow.title,
    href: `/escrow/${invite.escrowId}`,
    emailPref: "emailEscrow",
    emailSubject: "Escrow invite declined",
    emailText: mpEmail(null, [`Your escrow invite for "${invite.escrow.title}" was declined.`]),
  });
  return ok(res, { ok: true });
});

escrowRouter.post("/invite/:token/accept", requireAuth, async (req, res) => {
  const invite = await prisma.escrowInvite.findUnique({
    where: { token: param(req, "token") },
    include: { escrow: true },
  });
  if (!invite || invite.expiresAt < new Date()) {
    return fail(res, 400, "INVALID_INVITE", "Invite invalid or expired");
  }
  const updated = await prisma.$transaction(async (tx) => {
    await tx.escrowInvite.update({
      where: { id: invite.id },
      data: { acceptedByUserId: req.user!.id },
    });
    return tx.escrow.update({
      where: { id: invite.escrowId },
      data: { sellerId: req.user!.id, status: "AWAITING_FUNDS" },
      include: { milestones: true },
    });
  });
  notifyUser(invite.escrow.buyerId, {
    title: "Escrow invite accepted",
    body: invite.escrow.title,
    href: `/escrow/${invite.escrowId}`,
    emailPref: "emailEscrow",
    emailSubject: "Escrow invite accepted",
    emailText: mpEmail(null, [`Your escrow invite for "${invite.escrow.title}" was accepted.`]),
  });
  return ok(res, serialize(updated));
});

escrowRouter.post("/:id/fund", requireAuth, async (req, res) => {
  const escrow = await prisma.escrow.findFirst({
    where: { id: param(req, "id"), buyerId: req.user!.id },
    include: { milestones: true },
  });
  if (!escrow) return fail(res, 404, "NOT_FOUND", "Escrow not found");
  if (!escrow.sellerId) return fail(res, 400, "NO_SELLER", "Seller must accept invite first");
  if (escrow.status !== "AWAITING_FUNDS" && escrow.status !== "DRAFT") {
    return fail(res, 400, "BAD_STATE", `Cannot fund in status ${escrow.status}`);
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      await lockToHold(
        tx,
        req.user!.id,
        escrow.currency,
        escrow.amountMinor,
        "ESCROW_HOLD",
        `Escrow fund ${escrow.title}`,
        escrow.id,
      );
      await tx.escrowMilestone.updateMany({
        where: { escrowId: escrow.id },
        data: { status: "FUNDED" },
      });
      await recordTx(tx, {
        userId: req.user!.id,
        kind: "escrow",
        title: escrow.title,
        subtitle: "Escrow funded",
        currency: escrow.currency,
        amountDisplay: `−${formatMoney(escrow.currency, escrow.amountMinor)}`,
        amountPositive: false,
        status: "HELD",
        icon: "shield",
      });
      return tx.escrow.update({
        where: { id: escrow.id },
        data: { status: "ACTIVE", progress: 0.5 },
        include: { milestones: true },
      });
    });
    const partyIds = [escrow.buyerId, ...(escrow.sellerId ? [escrow.sellerId] : [])].filter(Boolean);
    for (const userId of partyIds) {
      notifyUser(userId, {
        title: "Escrow funded",
        body: `"${escrow.title}" is now active and funded (${formatMoney(escrow.currency, escrow.amountMinor)}).`,
        href: `/escrow/${escrow.id}`,
        emailPref: "emailEscrow",
        emailSubject: "Escrow funded",
        emailText: mpEmail(null, [
          `Escrow "${escrow.title}" is now active and funded (${formatMoney(escrow.currency, escrow.amountMinor)}).`,
        ]),
      });
    }
    return ok(res, serialize(updated));
  } catch (e) {
    return fail(res, 400, "FUND_FAILED", e instanceof Error ? e.message : "Fund failed");
  }
});

escrowRouter.post("/:id/milestones/:msId/release", requireAuth, async (req, res) => {
  const escrow = await prisma.escrow.findFirst({
    where: { id: param(req, "id"), buyerId: req.user!.id },
    include: { milestones: true },
  });
  if (!escrow?.sellerId) return fail(res, 404, "NOT_FOUND", "Escrow not found");
  const ms = escrow.milestones.find((m) => m.id === param(req, "msId"));
  if (!ms || ms.status !== "FUNDED") return fail(res, 400, "BAD_STATE", "Milestone not releasable");

  const gate = releaseGate({
    milestoneStatus: ms.status,
    releaseRequestedAt: ms.releaseRequestedAt,
    orderStatus: (await prisma.marketOrder.findFirst({ where: { escrowId: escrow.id }, select: { status: true } }))
      ?.status ?? null,
  });
  if (!gate.canRelease) {
    return fail(res, 400, "NOT_READY", gate.waitReason ?? "Seller has not confirmed shipment yet");
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      await settleEscrowRelease(
        tx,
        escrow.buyerId,
        escrow.sellerId!,
        escrow.currency,
        ms.amountMinor,
        `Release ${ms.label}`,
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
        include: { milestones: true },
      });
    });
    if (updated?.status === "COMPLETED") {
      await prisma.marketOrder.updateMany({
        where: { escrowId: escrow.id, status: { in: ["IN_ESCROW", "SHIPPED", "DELIVERED"] } },
        data: { status: "COMPLETED" },
      });
    }
    const partyIds = [escrow.buyerId, escrow.sellerId!].filter(Boolean);
    const releaseTitle = updated?.status === "COMPLETED" ? "Escrow completed" : "Milestone released";
    for (const userId of partyIds) {
      notifyUser(userId, {
        title: releaseTitle,
        body:
          updated?.status === "COMPLETED"
            ? `"${escrow.title}" is complete. Milestone "${ms.label}" was released.`
            : `"${ms.label}" released · ${formatMoney(escrow.currency, ms.amountMinor)}`,
        href: `/escrow/${escrow.id}`,
        emailPref: "emailEscrow",
        emailSubject: releaseTitle,
        emailText: mpEmail(null, [
          updated?.status === "COMPLETED"
            ? `Escrow "${escrow.title}" is complete. Milestone "${ms.label}" was released.`
            : `Milestone "${ms.label}" was released on escrow "${escrow.title}".`,
        ]),
      });
    }
    return ok(res, serialize(updated));
  } catch (e) {
    return fail(res, 400, "RELEASE_FAILED", e instanceof Error ? e.message : "Release failed");
  }
});

escrowRouter.post("/:id/dispute", requireAuth, async (req, res) => {
  const body = z.object({ reason: z.string().min(5), evidence: z.any().optional() }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Reason required");
  const escrow = await prisma.escrow.findFirst({
    where: {
      id: param(req, "id"),
      OR: [{ buyerId: req.user!.id }, { sellerId: req.user!.id }],
    },
  });
  if (!escrow) return fail(res, 404, "NOT_FOUND", "Escrow not found");
  const dispute = await prisma.$transaction(async (tx) => {
    await tx.escrow.update({ where: { id: escrow.id }, data: { status: "DISPUTED" } });
    return tx.dispute.create({
      data: {
        escrowId: escrow.id,
        openedById: req.user!.id,
        reason: body.data.reason,
        evidence: body.data.evidence ?? {},
      },
    });
  });
  const peerId = req.user!.id === escrow.buyerId ? escrow.sellerId : escrow.buyerId;
  if (peerId) {
    notifyUser(peerId, {
      title: "Escrow disputed",
      body: body.data.reason.slice(0, 120),
      href: `/escrow/${escrow.id}`,
      emailPref: "emailEscrow",
      emailSubject: "Escrow disputed",
      emailText: mpEmail(null, [`Escrow "${escrow.title}" was disputed: ${body.data.reason.slice(0, 200)}`]),
    });
  }
  return ok(res, serialize(dispute), 201);
});

escrowRouter.post("/:id/documents", requireAuth, async (req, res) => {
  const body = z
    .object({ name: z.string().min(1), url: z.string().min(4), note: z.string().optional() })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid document");
  const id = String(param(req, "id"));
  const escrow = await prisma.escrow.findFirst({
    where: {
      id,
      OR: [{ buyerId: req.user!.id }, { sellerId: req.user!.id }],
    },
  });
  if (!escrow) return fail(res, 404, "NOT_FOUND", "Escrow not found");
  const doc = await prisma.escrowDocument.create({
    data: { escrowId: escrow.id, name: body.data.name, url: body.data.url },
  });
  const peerId = req.user!.id === escrow.buyerId ? escrow.sellerId : escrow.buyerId;
  if (peerId) {
    notifyUser(peerId, {
      title: "New escrow document",
      body: `${body.data.name} · ${escrow.title}`,
      href: `/escrow/${escrow.id}`,
      emailPref: "emailEscrow",
      emailSubject: "New escrow document",
      emailText: mpEmail(null, [`${body.data.name} was added to escrow "${escrow.title}".`]),
    });
  }
  return ok(res, serialize(doc), 201);
});

escrowRouter.post("/:id/milestones/:msId/request-release", requireAuth, async (req, res) => {
  const escrowId = String(param(req, "id"));
  const msId = String(param(req, "msId"));
  const escrow = await prisma.escrow.findFirst({
    where: { id: escrowId, sellerId: req.user!.id },
    include: { milestones: true },
  });
  if (!escrow) return fail(res, 404, "NOT_FOUND", "Escrow not found");
  const ms = escrow.milestones.find((m) => m.id === msId);
  if (!ms) return fail(res, 404, "NOT_FOUND", "Milestone not found");
  if (ms.status !== "FUNDED") {
    return fail(res, 400, "BAD_STATE", "Only funded milestones can request release");
  }
  await prisma.escrowMilestone.update({
    where: { id: ms.id },
    data: { releaseRequestedAt: new Date() },
  });
  notifyUser(escrow.buyerId, {
    title: "Seller requested release",
    body: `${ms.label} · ${escrow.title} · confirm shipped/delivered then release`,
    href: `/escrow/${escrow.id}`,
    emailPref: "emailEscrow",
    emailSubject: "Seller requested release",
    emailText: mpEmail(null, [`Seller requested release for "${ms.label}" on escrow "${escrow.title}".`]),
  });
  return ok(res, serialize({ ok: true, milestoneId: msId, releaseRequestedAt: new Date().toISOString() }));
});

escrowRouter.post("/:id/counter", requireAuth, async (req, res) => {
  const body = z
    .object({
      amountMinor: z.union([z.string(), z.number()]),
      note: z.string().optional(),
      milestones: z
        .array(z.object({ label: z.string(), amountMinor: z.union([z.string(), z.number()]) }))
        .optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid counter");
  const escrowId = String(param(req, "id"));
  const escrow = await prisma.escrow.findFirst({
    where: { id: escrowId, sellerId: req.user!.id },
  });
  if (!escrow) return fail(res, 404, "NOT_FOUND", "Escrow not found");
  const updated = await prisma.$transaction(async (tx) => {
    const e = await tx.escrow.update({
      where: { id: escrow.id },
      data: { amountMinor: BigInt(body.data.amountMinor), status: "AWAITING_FUNDS" },
    });
    if (body.data.milestones?.length) {
      await tx.escrowMilestone.deleteMany({ where: { escrowId: escrow.id } });
      for (let i = 0; i < body.data.milestones.length; i++) {
        await tx.escrowMilestone.create({
          data: {
            escrowId: escrow.id,
            label: body.data.milestones[i].label,
            amountMinor: BigInt(body.data.milestones[i].amountMinor),
            sortOrder: i,
          },
        });
      }
    }
    return tx.escrow.findUnique({
      where: { id: e.id },
      include: { milestones: { orderBy: { sortOrder: "asc" } } },
    });
  });
  notifyUser(escrow.buyerId, {
    title: "Counter offer received",
    body: body.data.note || escrow.title,
    href: `/escrow/${escrow.id}`,
    emailPref: "emailEscrow",
    emailSubject: "Counter offer received",
    emailText: mpEmail(null, [`You received a counter offer on escrow "${escrow.title}".`]),
  });
  return ok(res, serialize(updated));
});

escrowRouter.post("/:id/dispute/messages", requireAuth, async (req, res) => {
  const body = z.object({ message: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "message required");
  const escrowId = String(param(req, "id"));
  const escrow = await prisma.escrow.findFirst({
    where: {
      id: escrowId,
      OR: [{ buyerId: req.user!.id }, { sellerId: req.user!.id }],
    },
    include: { disputes: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!escrow) return fail(res, 404, "NOT_FOUND", "Escrow not found");
  const dispute = escrow.disputes[0];
  if (!dispute) return fail(res, 400, "NO_DISPUTE", "No open dispute");
  const evidence = (dispute.evidence as { messages?: { senderId: string; body: string; at: string }[] }) ?? {};
  const messages = evidence.messages ?? [];
  messages.push({
    senderId: req.user!.id,
    body: body.data.message,
    at: new Date().toISOString(),
  });
  const updated = await prisma.dispute.update({
    where: { id: dispute.id },
    data: { evidence: { ...evidence, messages } },
  });
  const peerId = req.user!.id === escrow.buyerId ? escrow.sellerId : escrow.buyerId;
  if (peerId) {
    notifyUser(peerId, {
      title: "Dispute update",
      body: body.data.message.slice(0, 120),
      href: `/escrow/${escrow.id}`,
      emailPref: "emailEscrow",
      emailSubject: "Dispute update",
      emailText: mpEmail(null, [`New message on escrow dispute "${escrow.title}".`]),
    });
  }
  return ok(res, serialize(updated));
});

escrowRouter.post("/:id/cancel", requireAuth, async (req, res) => {
  const id = String(param(req, "id"));
  const escrow = await prisma.escrow.findFirst({
    where: { id, OR: [{ buyerId: req.user!.id }, { sellerId: req.user!.id }] },
  });
  if (!escrow) return fail(res, 404, "NOT_FOUND", "Escrow not found");
  if (["COMPLETED", "CANCELLED"].includes(escrow.status)) {
    return fail(res, 400, "BAD_STATE", "Escrow already closed");
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.escrow.update({ where: { id }, data: { status: "CANCELLED" } });
    return row;
  });
  const peerId = req.user!.id === escrow.buyerId ? escrow.sellerId : escrow.buyerId;
  if (peerId) {
    notifyUser(peerId, {
      title: "Escrow cancelled",
      body: escrow.title,
      href: `/escrow/${escrow.id}`,
      emailPref: "emailEscrow",
      emailSubject: "Escrow cancelled",
      emailText: mpEmail(null, [`Escrow "${escrow.title}" was cancelled.`]),
    });
  }
  return ok(res, serialize(updated));
});
