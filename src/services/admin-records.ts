import { prisma } from "../lib/prisma.js";

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
      payload: data.payload ?? {},
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
      ...data,
      ...(data.payload ? { payload: data.payload } : {}),
    },
  });
}
