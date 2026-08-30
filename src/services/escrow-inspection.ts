import type { InspectionStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

const WAIVED_INSPECTORS = new Set(["none", "self"]);

export function isThirdPartyInspector(inspectorId?: string | null) {
  return Boolean(inspectorId && !WAIVED_INSPECTORS.has(inspectorId));
}

export async function ensureInspectorsSeeded() {
  const count = await prisma.inspector.count();
  if (count > 0) return;
  await prisma.inspector.createMany({
    data: [
      { id: "sgs", name: "SGS", region: "Lagos · Guangzhou", feeMinor: 42000n, rating: 4.9 },
      { id: "bv", name: "Bureau Veritas", region: "Apapa · Ningbo", feeMinor: 38000n, rating: 4.8 },
      { id: "intertek", name: "Intertek", region: "Lagos · Shenzhen", feeMinor: 35000n, rating: 4.7 },
      { id: "self", name: "Buyer self-inspection", region: "Buyer arranges", feeMinor: 0n, rating: 0 },
      { id: "none", name: "No inspection", region: "Release on delivery", feeMinor: 0n, rating: 0 },
    ],
  });
}

export async function createInspectionForEscrow(input: {
  escrowId: string;
  inspectorId?: string | null;
  requiredDocs?: unknown;
}) {
  const inspectorId = input.inspectorId || "none";
  await ensureInspectorsSeeded();
  const existing = await prisma.inspectionRequest.findFirst({
    where: { escrowId: input.escrowId },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  const status: InspectionStatus = isThirdPartyInspector(inspectorId) ? "REQUESTED" : "WAIVED";
  return prisma.inspectionRequest.create({
    data: {
      escrowId: input.escrowId,
      inspectorId,
      status,
      requiredDocs: input.requiredDocs ?? undefined,
      passedAt: status === "WAIVED" ? new Date() : null,
    },
    include: { inspector: true },
  });
}

export async function getActiveInspection(escrowId: string) {
  return prisma.inspectionRequest.findFirst({
    where: { escrowId },
    orderBy: { createdAt: "desc" },
    include: { inspector: true },
  });
}

export function inspectionReleaseGate(inspection: {
  status: InspectionStatus;
  inspectorId: string;
} | null): { ok: boolean; reason: string | null } {
  if (!inspection) return { ok: true, reason: null };
  if (inspection.status === "WAIVED") return { ok: true, reason: null };
  if (inspection.status === "PASSED") return { ok: true, reason: null };
  if (inspection.status === "FAILED") {
    return { ok: false, reason: "Inspection failed — resolve via dispute before release." };
  }
  const label =
    inspection.status === "REQUESTED"
      ? "Waiting for MagnetPay ops to schedule inspection."
      : inspection.status === "SCHEDULED"
        ? "Inspection is scheduled — awaiting field report."
        : "Inspection in progress — release blocked until pass.";
  return { ok: false, reason: label };
}

export function serializeInspection(row: Awaited<ReturnType<typeof getActiveInspection>>) {
  if (!row) return null;
  return {
    id: row.id,
    escrowId: row.escrowId,
    inspectorId: row.inspectorId,
    inspectorName: row.inspector.name,
    status: row.status,
    requiredDocs: row.requiredDocs,
    reportUrl: row.reportUrl,
    failedReason: row.failedReason,
    assignedToId: row.assignedToId,
    passedAt: row.passedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
