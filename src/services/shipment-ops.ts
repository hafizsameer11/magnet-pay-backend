import type { Prisma, ShipmentStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  consumeHold,
  formatMoney,
  recordTx,
  unlockHoldCashback,
} from "./ledger.js";
import { notifyUserEmail } from "./notify.js";

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export const SHIPMENT_NEXT: Partial<
  Record<ShipmentStatus, "IN_TRANSIT" | "CUSTOMS" | "SETTLEMENT_PENDING" | "READY_FOR_POD" | "DELIVERED">
> = {
  HOLD_LOCKED: "IN_TRANSIT",
  IN_TRANSIT: "CUSTOMS",
  CUSTOMS: "SETTLEMENT_PENDING",
  SETTLEMENT_PENDING: "READY_FOR_POD",
  TOP_UP_REQUIRED: "READY_FOR_POD",
  READY_FOR_POD: "DELIVERED",
};

export type ShipmentActor = "buyer" | "admin";

export const SHIPMENT_BUYER_TARGETS = ["DELIVERED"] as const;

export const SHIPMENT_ADVANCE_TARGETS = [
  "IN_TRANSIT",
  "CUSTOMS",
  "SETTLEMENT_PENDING",
  "READY_FOR_POD",
  "DELIVERED",
] as const;

export const SHIPMENT_DOCUMENT_KINDS = [
  "commercial_invoice",
  "packing_list",
  "bill_of_lading",
  "certificate_of_origin",
  "customs_duty_receipt",
  "customs_clearance",
  "customs_assessment",
  "pod_photo",
  "pod_signature",
  "other",
] as const;

export type ShipmentCostLine = { label: string; amountMinor: number };

function breakdownSummary(lines: ShipmentCostLine[]) {
  return lines.map((l) => `${l.label}: ₦${(l.amountMinor / 100).toLocaleString()}`).join(" · ");
}

type ShipmentWithOrder = {
  marketOrder?: { id: string; status: string } | null;
};

function requireSellerShippedForMarketOrder(shipment: ShipmentWithOrder, action: string) {
  if (!shipment.marketOrder) return;
  if (!["SHIPPED", "DELIVERED", "COMPLETED"].includes(shipment.marketOrder.status)) {
    throw new Error(`Seller must mark the order as shipped before ${action}`);
  }
}

function assertValidShipmentTransition(current: ShipmentStatus, target: ShipmentStatus) {
  const expected = SHIPMENT_NEXT[current];
  if (!expected || expected !== target) {
    throw new Error(
      expected
        ? `Invalid status change: from ${current.replace(/_/g, " ")} you can only move to ${expected.replace(/_/g, " ")}`
        : `Cannot advance from ${current.replace(/_/g, " ")}`,
    );
  }
}

export async function attachShipmentDocument(input: {
  shipmentId: string;
  userId?: string;
  kind: string;
  name: string;
  url: string;
  eventMessage?: string;
  allowPod?: boolean;
}) {
  const shipment = await prisma.shipment.findFirst({
    where: {
      id: input.shipmentId,
      ...(input.userId ? { userId: input.userId } : {}),
    },
    include: { marketOrder: { select: { id: true, status: true } } },
  });
  if (!shipment) throw new Error("Shipment not found");

  if (input.kind.startsWith("pod_") && !input.allowPod) {
    if (shipment.status !== "READY_FOR_POD") {
      throw new Error("Proof of delivery can only be submitted when the shipment is ready for delivery confirmation");
    }
    requireSellerShippedForMarketOrder(shipment, "confirming delivery");
  }

  const doc = await prisma.$transaction(async (tx) => {
    const row = await tx.shipmentDocument.create({
      data: {
        shipmentId: shipment.id,
        kind: input.kind,
        name: input.name,
        url: input.url,
      },
    });
    await tx.shipmentEvent.create({
      data: {
        shipmentId: shipment.id,
        status: shipment.status,
        message: input.eventMessage ?? `Document uploaded: ${input.name}`,
      },
    });
    return row;
  });
  return doc;
}

export async function removeShipmentDocument(input: { shipmentId: string; documentId: string; userId?: string }) {
  const doc = await prisma.shipmentDocument.findFirst({
    where: { id: input.documentId, shipmentId: input.shipmentId },
    include: { shipment: true },
  });
  if (!doc) throw new Error("Document not found");
  if (input.userId && doc.shipment.userId !== input.userId) throw new Error("Document not found");

  await prisma.$transaction(async (tx) => {
    await tx.shipmentDocument.delete({ where: { id: doc.id } });
    await tx.shipmentEvent.create({
      data: {
        shipmentId: doc.shipmentId,
        status: doc.shipment.status,
        message: `Document removed: ${doc.name}`,
      },
    });
  });
}

async function syncOrderLogisticsFromShipment(tx: TxClient, shipmentId: string, shipmentStatus: string) {
  const order = await tx.marketOrder.findFirst({ where: { shipmentId } });
  if (!order) return;
  let logisticsStatus: "BOOKED" | "IN_TRANSIT" | "DELIVERED" = "BOOKED";
  if (shipmentStatus === "DELIVERED") logisticsStatus = "DELIVERED";
  else if (
    ["IN_TRANSIT", "CUSTOMS", "SETTLEMENT_PENDING", "TOP_UP_REQUIRED", "READY_FOR_POD"].includes(shipmentStatus)
  ) {
    logisticsStatus = "IN_TRANSIT";
  }
  await tx.marketOrder.update({ where: { id: order.id }, data: { logisticsStatus } });
}

export async function advanceShipmentOps(input: {
  shipmentId: string;
  userId?: string;
  status?: (typeof SHIPMENT_ADVANCE_TARGETS)[number];
  message?: string;
  skipPodCheck?: boolean;
  skipSellerShipCheck?: boolean;
  notify?: boolean;
  actor?: ShipmentActor;
}) {
  const actor = input.actor ?? "admin";
  const shipment = await prisma.shipment.findFirst({
    where: {
      id: input.shipmentId,
      ...(input.userId ? { userId: input.userId } : {}),
    },
    include: { marketOrder: { select: { id: true, status: true } } },
  });
  if (!shipment) {
    throw new Error("Shipment not found");
  }

  const status = input.status ?? SHIPMENT_NEXT[shipment.status];
  if (!status) {
    throw new Error(`Cannot advance from ${shipment.status}`);
  }

  if (actor === "buyer") {
    if (status !== "DELIVERED") {
      throw new Error("Shipment progress is updated by MagnetPay logistics — you can only confirm delivery");
    }
    if (shipment.status !== "READY_FOR_POD") {
      throw new Error("Shipment is not ready for proof of delivery yet");
    }
    requireSellerShippedForMarketOrder(shipment, "confirming delivery");
  }

  assertValidShipmentTransition(shipment.status, status);

  if (status !== "IN_TRANSIT" || !input.skipSellerShipCheck) {
    requireSellerShippedForMarketOrder(
      shipment,
      status === "IN_TRANSIT" ? "cargo can move in transit" : status.replace(/_/g, " ").toLowerCase(),
    );
  }

  if (status === "DELIVERED" && !input.skipPodCheck) {
    const podDocs = await prisma.shipmentDocument.findMany({
      where: { shipmentId: shipment.id, kind: { startsWith: "pod_" } },
    });
    if (!podDocs.length) {
      throw new Error("Upload proof-of-delivery photos or signature before confirming delivery");
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.shipmentEvent.create({
      data: {
        shipmentId: shipment.id,
        status,
        message: input.message ?? status.replace(/_/g, " "),
      },
    });
    const row = await tx.shipment.update({
      where: { id: shipment.id },
      data: { status },
      include: { events: true, hold: true, settlement: true, documents: true },
    });
    await syncOrderLogisticsFromShipment(tx, shipment.id, status);
    return row;
  });

  if (input.notify !== false) {
    const user = await prisma.user.findUnique({
      where: { id: shipment.userId },
      select: { email: true, name: true, notificationPrefs: true },
    });
    notifyUserEmail(
      user,
      "emailShipments",
      `Shipment update · ${shipment.ref}`,
      `Hi ${user?.name ?? "there"},\n\nShipment ${shipment.ref} is now ${status.replace(/_/g, " ").toLowerCase()}.\n\n— MagnetPay`,
    );
  }

  return updated;
}

export async function settleShipmentOps(input: {
  shipmentId: string;
  userId?: string;
  finalMinor?: bigint;
  breakdown?: ShipmentCostLine[];
  notes?: string;
  notify?: boolean;
}) {
  const shipment = await prisma.shipment.findFirst({
    where: {
      id: input.shipmentId,
      ...(input.userId ? { userId: input.userId } : {}),
    },
    include: { hold: true, settlement: true, marketOrder: { select: { id: true, status: true } } },
  });
  if (!shipment?.hold) {
    throw new Error("Shipment/hold not found");
  }
  if (shipment.settlement) {
    throw new Error("Already settled");
  }
  requireSellerShippedForMarketOrder(shipment, "customs settlement");

  let finalMinor = input.finalMinor;
  const breakdown = input.breakdown?.filter((l) => l.label.trim() && l.amountMinor > 0) ?? [];
  if (breakdown.length > 0) {
    const sum = breakdown.reduce((acc, l) => acc + BigInt(l.amountMinor), 0n);
    if (finalMinor != null && finalMinor !== sum) {
      throw new Error("finalMinor must match the sum of breakdown lines");
    }
    finalMinor = sum;
  }
  if (finalMinor == null || finalMinor <= 0n) {
    throw new Error("finalMinor or breakdown required");
  }

  const locked = shipment.hold.lockedMinor;
  const currency = shipment.hold.currency;
  const breakdownJson = breakdown.length ? breakdown : undefined;
  const settleMessage =
    breakdown.length > 0
      ? `Settled ${formatMoney(currency, finalMinor)} (${breakdownSummary(breakdown)})`
      : `Settled final ${formatMoney(currency, finalMinor)}`;

  const result = await prisma.$transaction(async (tx) => {
    let cashbackMinor = 0n;
    let topUpMinor = 0n;
    let nextStatus: "READY_FOR_POD" | "TOP_UP_REQUIRED" = "READY_FOR_POD";

    if (finalMinor! < locked) {
      cashbackMinor = locked - finalMinor!;
      await consumeHold(tx, shipment.userId, currency, finalMinor!, "LOGISTICS_HOLD", "Logistics final charge");
      await unlockHoldCashback(
        tx,
        shipment.userId,
        currency,
        cashbackMinor,
        "LOGISTICS_HOLD",
        "Logistics cashback",
      );
      await recordTx(tx, {
        userId: shipment.userId,
        kind: "logistics_cashback",
        title: `Cashback ${shipment.ref}`,
        currency,
        amountDisplay: `+${formatMoney(currency, cashbackMinor)}`,
        amountPositive: true,
        icon: "ship",
      });
    } else if (finalMinor! > locked) {
      topUpMinor = finalMinor! - locked;
      await consumeHold(tx, shipment.userId, currency, locked, "LOGISTICS_HOLD", "Logistics estimated charge");
      nextStatus = "TOP_UP_REQUIRED";
      await tx.notification.create({
        data: {
          userId: shipment.userId,
          title: "Top-up required",
          body: `Shipment ${shipment.ref} needs ${formatMoney(currency, topUpMinor)} more after customs.`,
        },
      });
    } else {
      await consumeHold(tx, shipment.userId, currency, locked, "LOGISTICS_HOLD", "Logistics final charge");
    }

    const settlement = await tx.shipmentSettlement.create({
      data: {
        shipmentId: shipment.id,
        finalMinor: finalMinor!,
        currency,
        cashbackMinor,
        topUpMinor,
        breakdown: breakdownJson as Prisma.InputJsonValue | undefined,
        notes: input.notes?.trim() || null,
      },
    });
    await tx.shipmentEvent.create({
      data: {
        shipmentId: shipment.id,
        status: nextStatus,
        message: settleMessage,
      },
    });
    const s = await tx.shipment.update({
      where: { id: shipment.id },
      data: { status: nextStatus },
      include: { hold: true, settlement: true, events: true, documents: true },
    });
    await syncOrderLogisticsFromShipment(tx, shipment.id, nextStatus);
    return { shipment: s, settlement };
  });

  if (input.notify !== false) {
    const user = await prisma.user.findUnique({
      where: { id: shipment.userId },
      select: { email: true, name: true, notificationPrefs: true },
    });
    if (result.settlement.topUpMinor > 0n) {
      notifyUserEmail(
        user,
        "emailShipments",
        `Top-up required · ${shipment.ref}`,
        `Hi ${user?.name ?? "there"},\n\nCustoms clearing for ${shipment.ref} requires an additional ${formatMoney(currency, result.settlement.topUpMinor)}.\n\n— MagnetPay`,
      );
    } else {
      notifyUserEmail(
        user,
        "emailShipments",
        `Customs settled · ${shipment.ref}`,
        `Hi ${user?.name ?? "there"},\n\nFinal clearing cost for ${shipment.ref} is ${formatMoney(currency, finalMinor!)}.${result.settlement.cashbackMinor > 0n ? ` ${formatMoney(currency, result.settlement.cashbackMinor)} was credited to your wallet.` : ""}\n\n— MagnetPay`,
      );
    }
  }

  return result;
}
