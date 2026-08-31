import { prisma } from "../lib/prisma.js";
import { getLogisticsProductWizardConfig } from "./logistics-product-config.js";
import { generatePartnerQuotes } from "./partner-quotes.js";
import { inferParcelTypeForOrder } from "./parcel-type-infer.js";

const DEFAULT_CBM = 0.012;
const DEFAULT_WEIGHT_KG = 2;

function resolveOriginCity(originHub: string | null | undefined, config: Awaited<ReturnType<typeof getLogisticsProductWizardConfig>>) {
  if (originHub) {
    const hub = config.originHubs.find((h) => h.code === originHub || h.city === originHub);
    if (hub) return hub.city;
    return originHub;
  }
  return config.originHubs[0]?.city ?? "Guangzhou";
}

/** Create a MagnetPay freight quote linked to a market order (post-checkout). */
export async function createOrderFreightQuote(orderId: string, userId: string) {
  const order = await prisma.marketOrder.findFirst({
    where: { id: orderId, userId },
    include: { items: { include: { product: true } } },
  });
  if (!order?.items.length) return null;

  const existingQuote = await prisma.shippingQuote.findFirst({
    where: {
      request: { orderId, userId },
      shipment: null,
      validUntil: { gt: new Date() },
    },
    include: { partner: true, request: true },
    orderBy: { estimatedMinor: "asc" },
  });
  if (existingQuote) {
    if (order.logisticsStatus === "NOT_BOOKED") {
      await prisma.marketOrder.update({
        where: { id: orderId },
        data: { logisticsStatus: "QUOTE_PENDING" },
      });
    }
    return existingQuote;
  }

  if (order.shipmentId || order.logisticsStatus === "BOOKED" || order.logisticsStatus === "IN_TRANSIT") {
    return null;
  }

  let cbm = 0;
  let weightKg = 0;
  let units = 0;
  let originHub: string | null = null;

  for (const item of order.items) {
    const p = item.product;
    units += item.qty;
    cbm += (p?.cbmPerUnit && p.cbmPerUnit > 0 ? p.cbmPerUnit : DEFAULT_CBM) * item.qty;
    weightKg += (p?.weightKgPerUnit && p.weightKgPerUnit > 0 ? p.weightKgPerUnit : DEFAULT_WEIGHT_KG) * item.qty;
    if (!originHub && p?.originHub) originHub = p.originHub;
  }

  const parcel = await inferParcelTypeForOrder(orderId, userId);
  if (!parcel) return null;

  const config = await getLogisticsProductWizardConfig();
  const origin = resolveOriginCity(originHub, config);
  const cargoDesc =
    order.items.length === 1
      ? `${order.items[0]!.qty} × ${order.items[0]!.title}`
      : `Order ${orderId.slice(0, 8)} · ${units} units`;

  const request = await prisma.shippingQuoteRequest.create({
    data: {
      userId,
      orderId,
      cargoDesc,
      cbm: Math.max(0.01, +cbm.toFixed(3)),
      weightKg: Math.max(1, +weightKg.toFixed(1)),
      origin,
      destination: "Lagos",
      mode: "SEA",
      parcelTypeId: parcel.parcelTypeId,
      destinationDelivery: order.deliveryMethod ?? "PICKUP",
    },
  });

  await prisma.marketOrder.update({
    where: { id: orderId },
    data: { logisticsStatus: "QUOTE_PENDING" },
  });

  const quotes = await generatePartnerQuotes({
    requestId: request.id,
    parcelTypeId: parcel.parcelTypeId,
    weightKg: request.weightKg,
    mode: "SEA",
  });

  return quotes[0] ?? null;
}
