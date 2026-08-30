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
};

export function releaseGate(input: {
  milestoneStatus: string;
  releaseRequestedAt: Date | string | null | undefined;
  orderStatus: string | null;
  inspectionOk?: boolean;
  inspectionReason?: string | null;
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
  if (!input.releaseRequestedAt) {
    return {
      canRelease: false,
      waitReason: "Waiting for the buyer to confirm delivery (proof of delivery).",
    };
  }
  return { canRelease: true, waitReason: null };
}

export async function fulfillmentForEscrow(escrowId: string, milestone?: {
  status: string;
  releaseRequestedAt?: Date | null;
}): Promise<Fulfillment> {
  const order = await prisma.marketOrder.findFirst({
    where: { escrowId },
    select: { id: true, status: true },
  });
  const inspection = await getActiveInspection(escrowId);
  const inspectionGate = inspectionReleaseGate(
    inspection ? { status: inspection.status, inspectorId: inspection.inspectorId } : null,
  );
  const orderStatus = order?.status ?? null;
  const gate = milestone
    ? releaseGate({
        milestoneStatus: milestone.status,
        releaseRequestedAt: milestone.releaseRequestedAt,
        orderStatus,
        inspectionOk: inspectionGate.ok,
        inspectionReason: inspectionGate.reason,
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
  };
}
