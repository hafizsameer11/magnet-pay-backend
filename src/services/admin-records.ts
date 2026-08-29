import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

function asJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function listAdminRecords(domain: string, status?: string) {
  return prisma.adminRecord.findMany({
    where: {
      domain,
      ...(status ? { status } : {}),
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    take: 500,
  });
}

export async function getAdminRecord(id: string) {
  return prisma.adminRecord.findUnique({ where: { id } });
}

export async function createAdminRecord(data: {
  domain: string;
  externalId?: string;
  title: string;
  subtitle?: string;
  status?: string;
  payload?: Record<string, unknown>;
}) {
  return prisma.adminRecord.create({
    data: {
      domain: data.domain,
      externalId: data.externalId,
      title: data.title,
      subtitle: data.subtitle,
      status: data.status,
      payload: data.payload ? asJson(data.payload) : {},
    },
  });
}

export async function patchAdminRecord(
  id: string,
  data: Partial<{
    title: string;
    subtitle: string;
    status: string;
    payload: Record<string, unknown>;
  }>,
) {
  return prisma.adminRecord.update({
    where: { id },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.subtitle !== undefined ? { subtitle: data.subtitle } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.payload !== undefined ? { payload: asJson(data.payload) } : {}),
    },
  });
}

/** Link a support conversation to an admin ticket record (create or refresh). */
export async function upsertSupportTicketRecord(input: {
  userId: string;
  userName: string;
  topic: string;
  conversationId: string;
  channel?: string;
}) {
  const externalId = `TKT-${input.conversationId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const existing = await prisma.adminRecord.findFirst({
    where: { domain: "ticket", externalId },
  });
  const payload = {
    userId: input.userId,
    conversationId: input.conversationId,
    priority: "normal",
    channel: input.channel ?? "in_app",
    slaHours: 24,
  };
  if (existing) {
    const merged = {
      ...(existing.payload as Record<string, unknown>),
      ...payload,
    };
    return prisma.adminRecord.update({
      where: { id: existing.id },
      data: {
        title: input.topic,
        subtitle: input.userName,
        status: existing.status === "closed" ? "open" : existing.status,
        payload: asJson(merged),
      },
    });
  }
  return createAdminRecord({
    domain: "ticket",
    externalId,
    title: input.topic,
    subtitle: input.userName,
    status: "open",
    payload,
  });
}

export async function listTicketsForUser(userId: string, status?: string) {
  const rows = await listAdminRecords("ticket", status);
  return rows.filter((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    return p.userId === userId;
  });
}
