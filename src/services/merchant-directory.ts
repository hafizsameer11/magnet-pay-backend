import { prisma } from "../lib/prisma.js";

export type ListAgentsOpts = {
  q?: string;
  state?: string;
  lga?: string;
  nearLat?: number;
  nearLng?: number;
  take?: number;
};

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isOpenNow(openHours: unknown): boolean | null {
  if (!openHours || typeof openHours !== "object") return null;
  const oh = openHours as { open?: string; close?: string; days?: number[] };
  if (!oh.open || !oh.close) return null;
  const now = new Date();
  const day = now.getDay(); // 0 Sun
  if (oh.days && !oh.days.includes(day === 0 ? 7 : day) && !oh.days.includes(day)) {
    return false;
  }
  const [ohH, ohM] = oh.open.split(":").map(Number);
  const [chH, chM] = oh.close.split(":").map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  const openMins = (ohH ?? 0) * 60 + (ohM ?? 0);
  const closeMins = (chH ?? 23) * 60 + (chM ?? 59);
  return mins >= openMins && mins <= closeMins;
}

/** Public agent directory — active + listed merchants only. */
export async function listAgents(opts: ListAgentsOpts = {}) {
  const take = opts.take ?? 50;
  const where: Record<string, unknown> = {
    status: "ACTIVE",
    listedInDirectory: true,
  };
  if (opts.state) where.state = opts.state;
  if (opts.lga) where.lga = opts.lga;
  if (opts.q) {
    where.OR = [
      { businessName: { contains: opts.q } },
      { address: { contains: opts.q } },
      { tag: { contains: opts.q } },
      { agentId: { contains: opts.q } },
      { lga: { contains: opts.q } },
    ];
  }

  const rows = await prisma.merchant.findMany({
    where,
    select: {
      id: true,
      agentId: true,
      tag: true,
      businessName: true,
      category: true,
      address: true,
      state: true,
      lga: true,
      lat: true,
      lng: true,
      phone: true,
      premiumPartner: true,
      openHours: true,
      tier: true,
    },
    take: take * 2,
    orderBy: [{ premiumPartner: "desc" }, { businessName: "asc" }],
  });

  let mapped = rows.map((r) => {
    const open = isOpenNow(r.openHours);
    let distanceKm: number | null = null;
    if (
      opts.nearLat != null &&
      opts.nearLng != null &&
      r.lat != null &&
      r.lng != null
    ) {
      distanceKm = haversineKm(opts.nearLat, opts.nearLng, r.lat, r.lng);
    }
    return { ...r, open, distanceKm };
  });

  if (opts.nearLat != null && opts.nearLng != null) {
    mapped = mapped
      .filter((r) => r.distanceKm != null)
      .sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
  }

  return mapped.slice(0, take);
}
