import { prisma } from "../lib/prisma.js";
import { getActiveInspection, inspectionReleaseGate } from "./escrow-inspection.js";

export type Fulfillment = {
  orderId: string | null;
  orderStatus: string | null;
  shipped: boolean;
  delivered: boolean;
  canRelease: boolean;
  waitReason: string | null;
  inspectionStatus: string | null;
  releaseRequested: boolean;
  sellerShipped: boolean;
};

export function releaseGate(input: {
  milestoneStatus: string;
  releaseRequestedAt: Date | string | null | undefined;
  orderStatus: string | null;
  inspectionOk?: boolean;
  inspectionReason?: string | null;
  hasDocuments?: boolean;
}): { canRelease: boolean; waitReason: string | null } {
  if (input.milestoneStatus !== "FUNDED") {
    return { canRelease: false, waitReason: "This milestone is not funded yet." };
  }
  if (input.inspectionOk === false) {
    return { canRelease: false, waitReason: input.inspectionReason ?? "Inspection must pass before release." };
  }
  if (input.orderStatus) {
    if (input.orderStatus === "IN_ESCROW" || input.orderStatus === "PENDING_PAYMENT") {
      return {
        canRelease: false,
        waitReason: "Waiting for the seller to mark this order as shipped.",
      };
    }
    if (input.orderStatus === "SHIPPED") {
      return {
        canRelease: false,
        waitReason: "Confirm proof of delivery before releasing funds.",
      };
    }
    if (input.orderStatus === "DELIVERED" || input.orderStatus === "COMPLETED") {
      return { canRelease: true, waitReason: null };
    }
    return { canRelease: false, waitReason: `Cannot release while order is ${input.orderStatus}.` };
  }
  const sellerReady = Boolean(input.releaseRequestedAt) || Boolean(input.hasDocuments);
  if (!sellerReady) {
    return {
      canRelease: false,
      waitReason: "Waiting for the seller to confirm shipment and request release.",
    };
  }
  return { canRelease: true, waitReason: null };
}

export async function fulfillmentForEscrow(escrowId: string, milestone?: {
  status: string;
  releaseRequestedAt?: Date | null;
}): Promise<Fulfillment> {
  const [order, inspection, docCount] = await Promise.all([
    prisma.marketOrder.findFirst({
      where: { escrowId },
      select: { id: true, status: true },
    }),
    getActiveInspection(escrowId),
    prisma.escrowDocument.count({ where: { escrowId } }),
  ]);
  const inspectionGate = inspectionReleaseGate(
    inspection ? { status: inspection.status, inspectorId: inspection.inspectorId } : null,
  );
  const orderStatus = order?.status ?? null;
  const releaseRequested = Boolean(milestone?.releaseRequestedAt);
  const sellerShipped = orderStatus
    ? orderStatus === "SHIPPED" || orderStatus === "DELIVERED" || orderStatus === "COMPLETED"
    : releaseRequested || docCount > 0;
  const gate = milestone
    ? releaseGate({
        milestoneStatus: milestone.status,
        releaseRequestedAt: milestone.releaseRequestedAt,
        orderStatus,
        inspectionOk: inspectionGate.ok,
        inspectionReason: inspectionGate.reason,
        hasDocuments: docCount > 0,
      })
    : { canRelease: false, waitReason: null };
  return {
    orderId: order?.id ?? null,
    orderStatus,
    shipped: orderStatus === "SHIPPED" || orderStatus === "DELIVERED" || orderStatus === "COMPLETED",
    delivered: orderStatus === "DELIVERED" || orderStatus === "COMPLETED",
    canRelease: gate.canRelease,
    waitReason: gate.waitReason,
    inspectionStatus: inspection?.status ?? null,
    releaseRequested,
    sellerShipped,
  };
}
