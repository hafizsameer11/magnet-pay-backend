import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { fail, ok, requireAuth, serialize } from "../lib/http.js";
import {
  formatMoney,
  lockToHold,
  recordTx,
  debitWallet,
} from "../services/ledger.js";
import { dutyPctForDestination, getHsCode, searchHsCodes } from "../data/hs-codes.js";
import { notifyUserEmail } from "../services/notify.js";
import { estimateQuoteMinor } from "../services/freight-pricing.js";
import { advanceShipmentOps, settleShipmentOps, attachShipmentDocument } from "../services/shipment-ops.js";
import { assertKycForAction, KycRequiredError } from "../services/kyc-access.js";

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

function estimateMinor(cbm: number, weightKg: number, mode: string): Promise<bigint> {
  return estimateQuoteMinor(cbm, weightKg, mode);
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
      orderId: z.string().uuid().optional(),
      destinationDelivery: z.enum(["PICKUP", "DOORSTEP"]).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid quote request");

  if (body.data.orderId) {
    const order = await prisma.marketOrder.findFirst({
      where: { id: body.data.orderId, userId: req.user!.id },
    });
    if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  }

  const estimatedMinor = await estimateMinor(body.data.cbm, body.data.weightKg, body.data.mode);
  const result = await prisma.$transaction(async (tx) => {
    const request = await tx.shippingQuoteRequest.create({
      data: {
        userId: req.user!.id,
        cargoDesc: body.data.cargoDesc,
        cbm: body.data.cbm,
        weightKg: body.data.weightKg,
        origin: body.data.origin,
        destination: body.data.destination,
        mode: body.data.mode,
        orderId: body.data.orderId ?? null,
        destinationDelivery: body.data.destinationDelivery ?? null,
      },
    });
    const quote = await tx.shippingQuote.create({
      data: {
        requestId: request.id,
        estimatedMinor,
        currency: "NGN",
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    if (body.data.orderId) {
      await tx.marketOrder.update({
        where: { id: body.data.orderId },
        data: { logisticsStatus: "QUOTE_PENDING" },
      });
    }
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
    include: { request: true, shipment: true },
  });
  if (!quote || quote.request.userId !== req.user!.id) {
    return fail(res, 404, "NOT_FOUND", "Quote not found");
  }
  if (quote.shipment) return fail(res, 400, "ALREADY_BOOKED", "Quote already booked");
  if (quote.validUntil < new Date()) return fail(res, 400, "EXPIRED", "Quote expired");

  try {
    await assertKycForAction(req.user!.id, "logistics_book");
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
      if (quote.request.orderId) {
        await tx.marketOrder.update({
          where: { id: quote.request.orderId },
          data: { shipmentId: s.id, logisticsStatus: "BOOKED" },
        });
      }
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
    if (e instanceof KycRequiredError) return fail(res, 403, "KYC_REQUIRED", e.message);
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
      claims: { orderBy: { createdAt: "desc" } },
      quote: { include: { request: true } },
      marketOrder: { select: { id: true, status: true, logisticsStatus: true } },
    },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Shipment not found");
  return ok(res, serialize(row));
});

logisticsRouter.post("/shipments/:id/advance", requireAuth, async (req, res) => {
  const body = z
    .object({
      status: z.enum(["IN_TRANSIT", "CUSTOMS", "SETTLEMENT_PENDING", "READY_FOR_POD", "DELIVERED"]).optional(),
      message: z.string().optional(),
    })
    .safeParse(req.body ?? {});
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid status");
  try {
    const updated = await advanceShipmentOps({
      shipmentId: req.params.id,
      userId: req.user!.id,
      status: body.data.status,
      message: body.data.message,
    });
    return ok(res, serialize(updated));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Advance failed";
    if (msg.includes("not found")) return fail(res, 404, "NOT_FOUND", msg);
    if (msg.includes("proof-of-delivery")) return fail(res, 400, "POD_REQUIRED", msg);
    return fail(res, 400, "BAD_STATE", msg);
  }
});

logisticsRouter.post("/shipments/:id/settle", requireAuth, async (req, res) => {
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
      userId: req.user!.id,
      finalMinor: body.data.finalMinor != null ? BigInt(body.data.finalMinor) : undefined,
      breakdown: body.data.breakdown,
      notes: body.data.notes,
    });
    return ok(res, serialize(result));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Settle failed";
    if (msg.includes("not found")) return fail(res, 404, "NOT_FOUND", msg);
    if (msg.includes("Already settled")) return fail(res, 400, "ALREADY_SETTLED", msg);
    return fail(res, 400, "SETTLE_FAILED", msg);
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
  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.shipmentClaim.create({
      data: {
        shipmentId: shipment.id,
        userId: req.user!.id,
        type: body.data.type,
        amountMinor: body.data.amountMinor != null ? BigInt(body.data.amountMinor) : null,
        currency: "NGN",
        description: body.data.description,
        evidenceUrls: body.data.evidenceUrls ?? [],
      },
    });
    await tx.shipmentEvent.create({
      data: {
        shipmentId: shipment.id,
        status: shipment.status,
        message: `Claim filed (${body.data.type}): ${body.data.description.slice(0, 120)}`,
      },
    });
    await tx.notification.create({
      data: {
        userId: req.user!.id,
        title: "Claim submitted",
        body: `${shipment.ref} · ${body.data.type}`,
      },
    });
    return claim;
  });
  return ok(res, serialize({ claim: result, shipmentId: shipment.id, ref: shipment.ref }), 201);
});

logisticsRouter.get("/shipments/:id/claims", requireAuth, async (req, res) => {
  const shipment = await prisma.shipment.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!shipment) return fail(res, 404, "NOT_FOUND", "Shipment not found");
  const claims = await prisma.shipmentClaim.findMany({
    where: { shipmentId: shipment.id },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(claims));
});

logisticsRouter.post("/shipments/:id/documents", requireAuth, async (req, res) => {
  const body = z
    .object({ kind: z.string().min(1), name: z.string().min(1), url: z.string().min(4) })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid document");
  try {
    const doc = await attachShipmentDocument({
      shipmentId: String(req.params.id),
      userId: req.user!.id,
      kind: body.data.kind,
      name: body.data.name,
      url: body.data.url,
    });
    return ok(res, serialize(doc), 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Upload failed";
    if (msg.includes("not found")) return fail(res, 404, "NOT_FOUND", msg);
    return fail(res, 400, "UPLOAD_FAILED", msg);
  }
});
