import type { ShipMode } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { estimateQuoteFromParcelType } from "./freight-pricing.js";

const DEFAULT_INCLUDES = ["Insurance", "Customs paperwork"];

type RateRow = {
  baseSurchargeMinor: number;
  rateMultiplierBps: number;
  etaLabel: string;
  badgeLabel: string | null;
  includes: unknown;
  ecoFriendly: boolean;
};

function applyRate(baseMinor: bigint, rate: RateRow): bigint {
  const scaled = (baseMinor * BigInt(rate.rateMultiplierBps)) / 10000n;
  return scaled + BigInt(rate.baseSurchargeMinor);
}

function parseIncludes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  return DEFAULT_INCLUDES;
}

export async function generatePartnerQuotes(input: {
  requestId: string;
  parcelTypeId: string;
  weightKg: number;
  mode: ShipMode;
  declaredUsd?: number;
}) {
  const breakdown = await estimateQuoteFromParcelType({
    parcelTypeId: input.parcelTypeId,
    weightKg: input.weightKg,
    declaredUsd: input.declaredUsd,
  });
  const baseMinor = breakdown.estimatedMinor;
  const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const partners = await prisma.logisticsPartner.findMany({
    where: { active: true, kind: "FREIGHT_FORWARDER", code: "MAGNET" },
    include: {
      rates: {
        where: { active: true, mode: input.mode },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      },
    },
    orderBy: [{ rating: "desc" }, { name: "asc" }],
  });

  const rows: {
    requestId: string;
    partnerId: string;
    estimatedMinor: bigint;
    currency: "NGN";
    validUntil: Date;
    etaLabel: string;
    serviceLabel: string | null;
    badgeLabel: string | null;
    includes: string[];
    ecoFriendly: boolean;
  }[] = [];

  for (const partner of partners) {
    const modes = Array.isArray(partner.modes) ? (partner.modes as string[]) : ["SEA"];
    if (!modes.includes(input.mode)) continue;

    const rate =
      partner.rates.find((r) => r.parcelTypeId === input.parcelTypeId) ??
      partner.rates.find((r) => r.parcelTypeId == null);

    const resolved: RateRow = rate
      ? {
          baseSurchargeMinor: rate.baseSurchargeMinor,
          rateMultiplierBps: rate.rateMultiplierBps,
          etaLabel: rate.etaLabel,
          badgeLabel: rate.badgeLabel,
          includes: rate.includes,
          ecoFriendly: rate.ecoFriendly,
        }
      : {
          baseSurchargeMinor: 0,
          rateMultiplierBps: 10000,
          etaLabel: input.mode === "AIR" ? "7–12 days" : input.mode === "EXPRESS" ? "5–8 days" : "26–32 days",
          badgeLabel: partner.code === "MAGNET" ? "Best value" : null,
          includes: DEFAULT_INCLUDES,
          ecoFriendly: false,
        };

    rows.push({
      requestId: input.requestId,
      partnerId: partner.id,
      estimatedMinor: applyRate(baseMinor, resolved),
      currency: "NGN",
      validUntil,
      etaLabel: resolved.etaLabel,
      serviceLabel: partner.serviceLabel,
      badgeLabel: resolved.badgeLabel,
      includes: parseIncludes(resolved.includes),
      ecoFriendly: resolved.ecoFriendly,
    });
  }

  if (!rows.length) {
    rows.push({
      requestId: input.requestId,
      partnerId: "",
      estimatedMinor: baseMinor,
      currency: "NGN",
      validUntil,
      etaLabel: "26–32 days",
      serviceLabel: "MagnetPay standard",
      badgeLabel: "Best value",
      includes: DEFAULT_INCLUDES,
      ecoFriendly: true,
    });
  }

  rows.sort((a, b) => (a.estimatedMinor < b.estimatedMinor ? -1 : a.estimatedMinor > b.estimatedMinor ? 1 : 0));

  const cheapest = rows[0]?.estimatedMinor ?? baseMinor;
  for (const row of rows) {
    if (!row.badgeLabel && row.estimatedMinor === cheapest) row.badgeLabel = "Best value";
  }

  return prisma.$transaction(async (tx) => {
    const created = [];
    for (const row of rows) {
      const quote = await tx.shippingQuote.create({
        data: {
          requestId: row.requestId,
          partnerId: row.partnerId || null,
          estimatedMinor: row.estimatedMinor,
          currency: row.currency,
          validUntil: row.validUntil,
          etaLabel: row.etaLabel,
          serviceLabel: row.serviceLabel,
          badgeLabel: row.badgeLabel,
          includes: row.includes,
          ecoFriendly: row.ecoFriendly,
        },
        include: { partner: true },
      });
      created.push(quote);
    }
    return created;
  });
}

export function serializeQuoteForCompare(
  quote: {
    id: string;
    estimatedMinor: bigint;
    validUntil: Date;
    etaLabel: string | null;
    serviceLabel: string | null;
    badgeLabel: string | null;
    includes: unknown;
    ecoFriendly: boolean;
    partner?: {
      id: string;
      name: string;
      code: string;
      rating: number | null;
      serviceLabel: string | null;
    } | null;
  },
  request?: { mode?: string; origin?: string; destination?: string; cbm?: number; weightKg?: number },
) {
  const includes = parseIncludes(quote.includes);
  return {
    id: quote.id,
    estimatedMinor: quote.estimatedMinor,
    validUntil: quote.validUntil,
    eta: quote.etaLabel ?? "26–32 days",
    serviceLabel: quote.serviceLabel ?? quote.partner?.serviceLabel ?? "Door-to-port",
    badge: quote.badgeLabel ?? "",
    includes,
    green: quote.ecoFriendly,
    rating: quote.partner?.rating ?? 4.7,
    name: quote.partner?.name ?? "MagnetPay Logistics",
    partnerId: quote.partner?.id ?? null,
    partnerCode: quote.partner?.code ?? "MAGNET",
    request,
  };
}
