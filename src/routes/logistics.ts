import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { fail, ok, requireAuth, serialize } from "../lib/http.js";
import {
  consumeHold,
  formatMoney,
  lockToHold,
  recordTx,
  unlockHoldCashback,
  debitWallet,
} from "../services/ledger.js";
import { dutyPctForDestination, getHsCode, searchHsCodes } from "../data/hs-codes.js";
import { notifyUserEmail } from "../services/notify.js";

export const logisticsRouter = Router();

logisticsRouter.get("/hs-codes", requireAuth, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const destination = typeof req.query.destination === "string" ? req.query.destination : "NG";
  const rows = searchHsCodes(q).map((row) => ({
    ...row,
    dutyPct: dutyPctForDestination(row, destination),
  }));
  return ok(res, serialize(rows));
});

logisticsRouter.get("/hs-codes/:code", requireAuth, async (req, res) => {
  const row = getHsCode(req.params.code);
  if (!row) return fail(res, 404, "NOT_FOUND", "HS code not found");
  const destination = typeof req.query.destination === "string" ? req.query.destination : "NG";
  return ok(res, serialize({ ...row, dutyPct: dutyPctForDestination(row, destination) }));
});

function estimateMinor(cbm: number, weightKg: number, mode: string): bigint {
  const base = mode === "AIR" ? 450000 : mode === "EXPRESS" ? 600000 : mode === "SEA" ? 180000 : 220000;
  const vol = Math.ceil(cbm * 100000);
  const w = Math.ceil(weightKg * 2500);
  return BigInt(base + vol + w);
}

logisticsRouter.post("/quotes", requireAuth, async (req, res) => {
  const body = z
    .object({
      cargoDesc: z.string().min(2),
      cbm: z.number().positive(),
      weightKg: z.number().positive(),
      origin: z.string().min(2),
      destination: z.string().min(2),
      mode: z.enum(["AIR", "SEA", "EXPRESS", "CONSOLIDATED"]).default("SEA"),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid quote request");

  const estimatedMinor = estimateMinor(body.data.cbm, body.data.weightKg, body.data.mode);
  const result = await prisma.$transaction(async (tx) => {
    const request = await tx.shippingQuoteRequest.create({
      data: { userId: req.user!.id, ...body.data },
    });
    const quote = await tx.shippingQuote.create({
      data: {
        requestId: request.id,
        estimatedMinor,
        currency: "NGN",
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    return { request, quote };
  });
  return ok(res, serialize(result), 201);
});

logisticsRouter.get("/quotes/:id", requireAuth, async (req, res) => {
  const quote = await prisma.shippingQuote.findUnique({
    where: { id: req.params.id },
    include: { request: true },
  });
  if (!quote || quote.request.userId !== req.user!.id) {
    return fail(res, 404, "NOT_FOUND", "Quote not found");
  }
  const mode = quote.request.mode;
  const eta = mode === "AIR" ? "7–12 days" : mode === "EXPRESS" ? "5–8 days" : "26–32 days";
  return ok(res, serialize({ ...quote, eta, rating: 4.7, includes: ["Insurance", "Customs paperwork"] }));
});

logisticsRouter.post("/quotes/:quoteId/book", requireAuth, async (req, res) => {
  const docBody = z
    .object({
      documents: z.array(z.object({ kind: z.string(), name: z.string(), url: z.string() })).optional(),
      hsCode: z.string().min(4).optional(),
      pickup: z
        .object({
          date: z.string().min(4),
          slot: z.string().min(2),
          contact: z.string().min(2),
          phone: z.string().min(6),
          addr: z.string().min(4),
          notes: z.string().optional(),
        })
        .optional(),
    })
    .safeParse(req.body ?? {});
  const quote = await prisma.shippingQuote.findUnique({
    where: { id: req.params.quoteId },
    include: { request: true },
  });
  if (!quote || quote.request.userId !== req.user!.id) {
    return fail(res, 404, "NOT_FOUND", "Quote not found");
  }
  if (quote.validUntil < new Date()) return fail(res, 400, "EXPIRED", "Quote expired");

  try {
    const shipment = await prisma.$transaction(async (tx) => {
      await lockToHold(
        tx,
        req.user!.id,
        quote.currency,
        quote.estimatedMinor,
        "LOGISTICS_HOLD",
        "Logistics quote hold",
        quote.id,
      );
      const ref = `MSK-${Date.now().toString().slice(-6)}`;
      const s = await tx.shipment.create({
        data: {
          userId: req.user!.id,
          quoteId: quote.id,
          ref,
          route: `${quote.request.origin} → ${quote.request.destination}`,
          mode: quote.request.mode,
          status: "HOLD_LOCKED",
          eta: "14 days",
        },
      });
      await tx.shipmentHold.create({
        data: {
          shipmentId: s.id,
          lockedMinor: quote.estimatedMinor,
          currency: quote.currency,
        },
      });
      await tx.shipmentEvent.create({
        data: { shipmentId: s.id, status: "HOLD_LOCKED", message: "Estimated amount locked" },
      });
      if (docBody.success && docBody.data.pickup) {
        const p = docBody.data.pickup;
        await tx.shipmentEvent.create({
          data: {
            shipmentId: s.id,
            status: "HOLD_LOCKED",
            message: `Pickup ${p.date} · ${p.slot} · ${p.contact} · ${p.addr}`,
          },
        });
      }
      if (docBody.success && docBody.data.hsCode) {
        const hs = getHsCode(docBody.data.hsCode);
        const duty = hs ? dutyPctForDestination(hs, quote.request.destination) : null;
        await tx.shipmentDocument.create({
          data: {
            shipmentId: s.id,
            kind: "hs",
            name: hs
              ? `${hs.code} · ${hs.description}${duty != null ? ` · ${duty}% duty` : ""}`
              : docBody.data.hsCode,
            url: `hs://${docBody.data.hsCode}`,
          },
        });
      }
      if (docBody.success && docBody.data.documents?.length) {
        for (const d of docBody.data.documents) {
          await tx.shipmentDocument.create({
            data: { shipmentId: s.id, kind: d.kind, name: d.name, url: d.url },
          });
        }
      }
      await recordTx(tx, {
        userId: req.user!.id,
        kind: "logistics_hold",
        title: `Shipment ${ref}`,
        subtitle: "Quote locked",
        currency: quote.currency,
        amountDisplay: formatMoney(quote.currency, quote.estimatedMinor),
        status: "HELD",
        icon: "ship",
      });
      return tx.shipment.findUnique({
        where: { id: s.id },
        include: { hold: true, events: true, quote: true },
      });
    });
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { email: true, name: true, notificationPrefs: true },
    });
    if (shipment) {
      notifyUserEmail(
        user,
        "emailShipments",
        `Shipment booked · ${shipment.ref}`,
        `Hi ${user?.name ?? "there"},\n\nYour shipment ${shipment.ref} (${shipment.route}) is booked and the quote amount is on hold.\n\n— MagnetPay`,
      );
    }
    return ok(res, serialize(shipment), 201);
  } catch (e) {
    return fail(res, 400, "BOOK_FAILED", e instanceof Error ? e.message : "Book failed");
  }
});

logisticsRouter.get("/shipments", requireAuth, async (req, res) => {
  const rows = await prisma.shipment.findMany({
    where: { userId: req.user!.id },
    include: { hold: true, settlement: true, events: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(rows));
});

logisticsRouter.get("/shipments/:id", requireAuth, async (req, res) => {
  const row = await prisma.shipment.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    include: {
      hold: true,
      settlement: true,
      events: { orderBy: { createdAt: "asc" } },
      documents: true,
      quote: { include: { request: true } },
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Shipment not found");
  return ok(res, serialize(row));
});

logisticsRouter.post("/shipments/:id/advance", requireAuth, async (req, res) => {
  const NEXT: Record<string, "IN_TRANSIT" | "CUSTOMS" | "SETTLEMENT_PENDING" | "READY_FOR_POD" | "DELIVERED"> = {
    HOLD_LOCKED: "IN_TRANSIT",
    IN_TRANSIT: "CUSTOMS",
    CUSTOMS: "SETTLEMENT_PENDING",
    SETTLEMENT_PENDING: "READY_FOR_POD",
    TOP_UP_REQUIRED: "READY_FOR_POD",
    READY_FOR_POD: "DELIVERED",
  };
  const body = z
    .object({
      status: z.enum(["IN_TRANSIT", "CUSTOMS", "SETTLEMENT_PENDING", "READY_FOR_POD", "DELIVERED"]).optional(),
      message: z.string().optional(),
    })
    .safeParse(req.body ?? {});
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid status");
  const shipment = await prisma.shipment.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!shipment) return fail(res, 404, "NOT_FOUND", "Shipment not found");
  const status = body.data.status ?? NEXT[shipment.status];
  if (!status) return fail(res, 400, "BAD_STATE", `Cannot advance from ${shipment.status}`);
  const updated = await prisma.$transaction(async (tx) => {
    await tx.shipmentEvent.create({
      data: {
        shipmentId: shipment.id,
        status,
        message: body.data.message ?? status.replace(/_/g, " "),
      },
    });
    return tx.shipment.update({
      where: { id: shipment.id },
      data: { status },
      include: { events: true, hold: true },
    });
  });
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { email: true, name: true, notificationPrefs: true },
  });
  notifyUserEmail(
    user,
    "emailShipments",
    `Shipment update · ${shipment.ref}`,
    `Hi ${user?.name ?? "there"},\n\nShipment ${shipment.ref} is now ${status.replace(/_/g, " ").toLowerCase()}.\n\n— MagnetPay`,
  );
  return ok(res, serialize(updated));
});

logisticsRouter.post("/shipments/:id/settle", requireAuth, async (req, res) => {
  const body = z
    .object({ finalMinor: z.union([z.string(), z.number()]) })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "finalMinor required");
  const finalMinor = BigInt(body.data.finalMinor);
  const shipment = await prisma.shipment.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    include: { hold: true, settlement: true },
  });
  if (!shipment?.hold) return fail(res, 404, "NOT_FOUND", "Shipment/hold not found");
  if (shipment.settlement) return fail(res, 400, "ALREADY_SETTLED", "Already settled");

  const locked = shipment.hold.lockedMinor;
  const currency = shipment.hold.currency;

  try {
    const result = await prisma.$transaction(async (tx) => {
      let cashbackMinor = 0n;
      let topUpMinor = 0n;
      let nextStatus: "READY_FOR_POD" | "TOP_UP_REQUIRED" = "READY_FOR_POD";

      if (finalMinor < locked) {
        cashbackMinor = locked - finalMinor;
        await consumeHold(tx, req.user!.id, currency, finalMinor, "LOGISTICS_HOLD", "Logistics final charge");
        await unlockHoldCashback(
          tx,
          req.user!.id,
          currency,
          cashbackMinor,
          "LOGISTICS_HOLD",
          "Logistics cashback",
        );
        await recordTx(tx, {
          userId: req.user!.id,
          kind: "logistics_cashback",
          title: `Cashback ${shipment.ref}`,
          currency,
          amountDisplay: `+${formatMoney(currency, cashbackMinor)}`,
          amountPositive: true,
          icon: "ship",
        });
      } else if (finalMinor > locked) {
        topUpMinor = finalMinor - locked;
        await consumeHold(tx, req.user!.id, currency, locked, "LOGISTICS_HOLD", "Logistics estimated charge");
        nextStatus = "TOP_UP_REQUIRED";
        await tx.notification.create({
          data: {
            userId: req.user!.id,
            title: "Top-up required",
            body: `Shipment ${shipment.ref} needs ${formatMoney(currency, topUpMinor)} more after customs.`,
          },
        });
      } else {
        await consumeHold(tx, req.user!.id, currency, locked, "LOGISTICS_HOLD", "Logistics final charge");
      }

      const settlement = await tx.shipmentSettlement.create({
        data: {
          shipmentId: shipment.id,
          finalMinor,
          currency,
          cashbackMinor,
          topUpMinor,
        },
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          status: nextStatus,
          message: `Settled final ${formatMoney(currency, finalMinor)}`,
        },
      });
      const s = await tx.shipment.update({
        where: { id: shipment.id },
        data: { status: nextStatus },
        include: { hold: true, settlement: true, events: true },
      });
      return { shipment: s, settlement };
    });
    return ok(res, serialize(result));
  } catch (e) {
    return fail(res, 400, "SETTLE_FAILED", e instanceof Error ? e.message : "Settle failed");
  }
});

logisticsRouter.post("/shipments/:id/top-up", requireAuth, async (req, res) => {
  const shipment = await prisma.shipment.findFirst({
    where: { id: req.params.id, userId: req.user!.id, status: "TOP_UP_REQUIRED" },
    include: { settlement: true },
  });
  if (!shipment?.settlement || shipment.settlement.topUpMinor <= 0n) {
    return fail(res, 400, "BAD_STATE", "No top-up due");
  }
  try {
    const updated = await prisma.$transaction(async (tx) => {
      await debitWallet(
        tx,
        req.user!.id,
        shipment.settlement!.currency,
        shipment.settlement!.topUpMinor,
        `Logistics top-up ${shipment.ref}`,
      );
      await recordTx(tx, {
        userId: req.user!.id,
        kind: "logistics_topup",
        title: `Top-up ${shipment.ref}`,
        currency: shipment.settlement!.currency,
        amountDisplay: `−${formatMoney(shipment.settlement!.currency, shipment.settlement!.topUpMinor)}`,
        amountPositive: false,
        icon: "ship",
      });
      await tx.shipmentEvent.create({
        data: { shipmentId: shipment.id, status: "READY_FOR_POD", message: "Top-up paid" },
      });
      return tx.shipment.update({
        where: { id: shipment.id },
        data: { status: "READY_FOR_POD" },
        include: { settlement: true, events: true },
      });
    });
    return ok(res, serialize(updated));
  } catch (e) {
    return fail(res, 400, "TOPUP_FAILED", e instanceof Error ? e.message : "Top-up failed");
  }
});

logisticsRouter.post("/shipments/:id/claim", requireAuth, async (req, res) => {
  const body = z
    .object({
      type: z.string().min(2),
      amountMinor: z.union([z.string(), z.number()]).optional(),
      description: z.string().min(5),
      evidenceUrls: z.array(z.string().min(4)).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid claim");
  const id = String(req.params.id);
  const shipment = await prisma.shipment.findFirst({
    where: { id, userId: req.user!.id },
  });
  if (!shipment) return fail(res, 404, "NOT_FOUND", "Shipment not found");
  const event = await prisma.$transaction(async (tx) => {
    const e = await tx.shipmentEvent.create({
      data: {
        shipmentId: shipment.id,
        status: shipment.status,
        message: `Claim (${body.data.type}): ${body.data.description.slice(0, 120)}`,
      },
    });
    await tx.notification.create({
      data: {
        userId: req.user!.id,
        title: "Claim submitted",
        body: `${shipment.ref} · ${body.data.type}`,
      },
    });
    return e;
  });
  return ok(res, serialize({ event, shipmentId: shipment.id, ref: shipment.ref }), 201);
});

logisticsRouter.post("/shipments/:id/documents", requireAuth, async (req, res) => {
  const body = z
    .object({ kind: z.string().min(1), name: z.string().min(1), url: z.string().min(4) })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid document");
  const shipment = await prisma.shipment.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!shipment) return fail(res, 404, "NOT_FOUND", "Shipment not found");
  const doc = await prisma.shipmentDocument.create({
    data: { shipmentId: shipment.id, kind: body.data.kind, name: body.data.name, url: body.data.url },
  });
  return ok(res, serialize(doc), 201);
});
