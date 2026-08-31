import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../lib/prisma.js";
import {fail, ok, requireAuth, serialize, param, inputJson } from "../lib/http.js";
import { formatMoney, lockToHold, recordTx, settleEscrowRelease } from "../services/ledger.js";
import {
  generateCombinations,
  variantInputSchema,
  variantKeyFromOptions,
  variantLabelFromOptions,
  type VariantAxis,
  type VariantOptions,
} from "../services/product-variants.js";
import { assertKycForAction, KycRequiredError } from "../services/kyc-access.js";
import { requireSellerKyb, sellerCanPublishLive } from "../services/seller-kyb.js";
import { advanceShipmentOps } from "../services/shipment-ops.js";
import {
  orderDocumentsForBuyer,
  orderDocumentsForSeller,
  REQUIRED_SELLER_DOC_KINDS,
} from "../services/order-docs.js";
import { mpEmail, notifyUser, notifyUsers } from "../services/user-notify.js";
import { parseProductSearchQuery, searchProducts } from "../services/product-search.js";

export const marketRouter = Router();

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const emptyToNull = (v: unknown) => (v === "" ? null : v);

const optionalUuid = z.preprocess(emptyToNull, z.string().uuid().nullable().optional());
const optionalUrl = z.preprocess(emptyToNull, z.string().url().nullable().optional());
const optionalNonEmptyString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

function validationMessage(error: z.ZodError, fallback = "Invalid product") {
  const issue = error.issues[0];
  if (!issue) return fallback;
  const path = issue.path.length ? issue.path.join(".") : "body";
  return `${path}: ${issue.message}`;
}

function isVideoMediaUrl(url: string) {
  return /\.(mp4|mov|m4v|webm)(\?|$)/i.test(url);
}

function firstImageMediaUrl(urls: string[] | undefined, fallback?: string | null) {
  if (!urls?.length) return fallback ?? null;
  return urls.find((u) => u && !isVideoMediaUrl(u)) ?? urls[0] ?? fallback ?? null;
}

const productShippingSchema = {
  cbmPerUnit: z.number().positive().optional(),
  weightKgPerUnit: z.number().positive().optional(),
  originHub: optionalNonEmptyString,
  leadTimeMin: z.number().int().nonnegative().optional(),
  leadTimeMax: z.number().int().nonnegative().optional(),
  packagingType: optionalNonEmptyString,
  defaultIncoterm: optionalNonEmptyString,
  parcelTypeId: optionalUuid,
};

const sellerProductCreateFields = {
  description: z.string().optional(),
  priceMinor: z.union([z.string(), z.number()]),
  currency: z.enum(["NGN", "CNY", "USD"]).default("USD"),
  imageUrl: optionalUrl,
  moq: z.string().optional(),
  categoryId: optionalUuid,
  mediaUrls: z.array(z.string().url()).optional(),
  active: z.boolean().optional(),
  stock: z.number().int().nonnegative().optional().nullable(),
  variantAxes: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).optional(),
  variants: z.array(variantInputSchema).optional(),
  pricingTiers: z
    .array(z.object({ from: z.string(), to: z.string().optional(), priceMinor: z.union([z.string(), z.number()]) }))
    .optional(),
  ...productShippingSchema,
};

const sellerProductPatchFields = {
  description: z.string().optional().nullable(),
  priceMinor: z.union([z.string(), z.number()]).optional(),
  currency: z.enum(["NGN", "CNY", "USD"]).optional(),
  imageUrl: optionalUrl,
  moq: z.string().optional(),
  categoryId: optionalUuid,
  mediaUrls: z.array(z.string().url()).optional(),
  active: z.boolean().optional(),
  stock: z.number().int().nonnegative().optional().nullable(),
  variantAxes: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).optional(),
  variants: z.array(variantInputSchema).optional(),
  pricingTiers: z
    .array(z.object({ from: z.string(), to: z.string().optional(), priceMinor: z.union([z.string(), z.number()]) }))
    .optional(),
  ...productShippingSchema,
};

function orderLogisticsNextAction(order: {
  status: string;
  logisticsStatus: string;
  shipment?: { id: string; ref: string; status: string } | null;
}): string {
  if (order.status === "DELIVERED") return "RELEASE_ESCROW";
  if (order.shipment?.status === "TOP_UP_REQUIRED") return "TOP_UP_REQUIRED";
  if (
    order.shipment?.status === "READY_FOR_POD" &&
    ["SHIPPED", "DELIVERED", "COMPLETED"].includes(order.status)
  ) {
    return "CONFIRM_POD";
  }
  if (order.shipment) return "TRACK_SHIPMENT";
  if (order.logisticsStatus === "QUOTE_PENDING") return "COMPLETE_BOOKING";
  return "BOOK_FREIGHT";
}

function shipmentSummary(shipment: {
  id: string;
  ref: string;
  route: string;
  status: string;
  eta?: string | null;
} | null | undefined) {
  if (!shipment) return null;
  return {
    id: shipment.id,
    ref: shipment.ref,
    route: shipment.route,
    status: shipment.status,
    eta: shipment.eta ?? null,
  };
}

async function syncProductVariants(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  productId: string,
  basePriceMinor: bigint,
  variantAxes: VariantAxis[] | undefined,
  variants: z.infer<typeof variantInputSchema>[] | undefined,
) {
  await tx.productVariant.deleteMany({ where: { productId } });
  let rows = variants ?? [];
  if (!rows.length && variantAxes?.length) {
    rows = generateCombinations(variantAxes).map((options) => ({
      options,
      priceMinor: basePriceMinor.toString(),
    }));
  }
  for (const v of rows) {
    await tx.productVariant.create({
      data: {
        productId,
        sku: v.sku ?? null,
        options: v.options,
        priceMinor: BigInt(v.priceMinor),
        stock: v.stock ?? null,
        imageUrl: v.imageUrl ?? null,
      },
    });
  }
}

function unitMinorForCartItem(item: {
  product: { priceMinor: bigint };
  variant?: { priceMinor: bigint } | null;
}) {
  return item.variant?.priceMinor ?? item.product.priceMinor;
}

async function sellerStoreFor(userId: string) {
  const owned = await prisma.sellerStore.findUnique({ where: { userId } });
  if (owned) return owned;
  const membership = await prisma.sellerStoreMember.findFirst({
    where: { userId },
    include: { store: true },
  });
  return membership?.store ?? null;
}

async function ensureSellerStore(userId: string, name?: string) {
  const existing = await sellerStoreFor(userId);
  if (existing) return existing;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return prisma.sellerStore.create({
    data: {
      userId,
      name: name || user?.name || "My store",
      description: null,
      verified: false,
    },
  });
}

/* ─── Catalog (public) ─────────────────────────────────────────────── */

marketRouter.get("/products", async (req, res) => {
  const filters = parseProductSearchQuery(req.query as Record<string, unknown>);
  const products = await searchProducts(filters);
  return ok(res, serialize(products));
});

marketRouter.get("/products/:id", async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: param(req, "id") },
    include: {
      store: true,
      category: true,
      media: { orderBy: { sortOrder: "asc" } },
      variants: { where: { active: true }, orderBy: { createdAt: "asc" } },
      reviews: {
        include: { user: { select: { id: true, name: true, avatarUrl: true } } },
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
  });
  if (!product) return fail(res, 404, "NOT_FOUND", "Product not found");
  return ok(res, serialize(product));
});

marketRouter.get("/categories", async (_req, res) => {
  const cats = await prisma.category.findMany({ orderBy: { name: "asc" } });
  return ok(res, serialize(cats));
});

marketRouter.get("/stores/:id", async (req, res) => {
  const store = await prisma.sellerStore.findUnique({
    where: { id: param(req, "id") },
    include: {
      user: { select: { id: true, name: true, avatarUrl: true } },
      products: { where: { active: true }, take: 40, orderBy: { createdAt: "desc" }, include: { category: true } },
    },
  });
  if (!store) return fail(res, 404, "NOT_FOUND", "Store not found");
  return ok(res, serialize(store));
});

/* ─── Seller store + products ──────────────────────────────────────── */

marketRouter.get("/seller/store", requireAuth, async (req, res) => {
  const store = await ensureSellerStore(req.user!.id);
  return ok(res, serialize(store));
});

marketRouter.patch("/seller/store", requireAuth, async (req, res) => {
  const body = z
    .object({
      name: z.string().min(2).optional(),
      tagline: z.string().optional().nullable(),
      description: z.string().optional().nullable(),
      bannerUrl: z.string().url().optional().nullable(),
      logoUrl: z.string().url().optional().nullable(),
      storefrontMeta: z
        .object({
          certifications: z.array(z.string()).optional(),
          factoryPhotos: z.array(z.string()).optional(),
          policies: z.array(z.object({ label: z.string(), summary: z.string() })).optional(),
        })
        .optional()
        .nullable(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid store");
  const store = await ensureSellerStore(req.user!.id, body.data.name);
  const updated = await prisma.sellerStore.update({
    where: { id: store.id },
    data: {
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(body.data.tagline !== undefined ? { tagline: body.data.tagline } : {}),
      ...(body.data.description !== undefined ? { description: body.data.description } : {}),
      ...(body.data.bannerUrl !== undefined ? { bannerUrl: body.data.bannerUrl } : {}),
      ...(body.data.logoUrl !== undefined ? { logoUrl: body.data.logoUrl } : {}),
      ...(body.data.storefrontMeta !== undefined
        ? { storefrontMeta: body.data.storefrontMeta ? JSON.parse(JSON.stringify(body.data.storefrontMeta)) : null }
        : {}),
    },
  });
  return ok(res, serialize(updated));
});

marketRouter.get("/seller/products", requireAuth, async (req, res) => {
  const store = await ensureSellerStore(req.user!.id);
  const products = await prisma.product.findMany({
    where: { storeId: store.id },
    include: { category: true, media: { orderBy: { sortOrder: "asc" } }, variants: { where: { active: true } } },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(products));
});

marketRouter.post("/seller/products", requireAuth, async (req, res) => {
  const body = z
    .object({
      title: z.string().min(2),
      ...sellerProductCreateFields,
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", validationMessage(body.error));
  const store = await ensureSellerStore(req.user!.id);
  const canPublishLive = await sellerCanPublishLive(req.user!.id);
  const wantsActive = body.data.active ?? true;
  const active = canPublishLive && wantsActive;
  const moderationStatus = active ? "ACTIVE" : "PENDING";
  const product = await prisma.$transaction(async (tx) => {
    const p = await tx.product.create({
      data: {
        storeId: store.id,
        title: body.data.title,
        description: body.data.description,
        priceMinor: BigInt(body.data.priceMinor),
        currency: body.data.currency,
        imageUrl: body.data.imageUrl ?? firstImageMediaUrl(body.data.mediaUrls) ?? null,
        moq: body.data.moq ?? "1 unit",
        categoryId: body.data.categoryId ?? null,
        active,
        moderationStatus,
        ...(body.data.stock !== undefined ? { stock: body.data.stock } : {}),
        ...(body.data.variantAxes !== undefined ? { variantAxes: body.data.variantAxes } : {}),
        ...(body.data.pricingTiers !== undefined ? { pricingTiers: body.data.pricingTiers } : {}),
        ...(body.data.cbmPerUnit !== undefined ? { cbmPerUnit: body.data.cbmPerUnit } : {}),
        ...(body.data.weightKgPerUnit !== undefined ? { weightKgPerUnit: body.data.weightKgPerUnit } : {}),
        ...(body.data.originHub !== undefined ? { originHub: body.data.originHub } : {}),
        ...(body.data.leadTimeMin !== undefined ? { leadTimeMin: body.data.leadTimeMin } : {}),
        ...(body.data.leadTimeMax !== undefined ? { leadTimeMax: body.data.leadTimeMax } : {}),
        ...(body.data.packagingType !== undefined ? { packagingType: body.data.packagingType } : {}),
        ...(body.data.defaultIncoterm !== undefined ? { defaultIncoterm: body.data.defaultIncoterm } : {}),
        ...(body.data.parcelTypeId !== undefined ? { parcelTypeId: body.data.parcelTypeId } : {}),
      },
    });
    const urls = body.data.mediaUrls ?? (body.data.imageUrl ? [body.data.imageUrl] : []);
    for (let i = 0; i < urls.length; i++) {
      await tx.productMedia.create({
        data: { productId: p.id, url: urls[i], sortOrder: i },
      });
    }
    if (body.data.variantAxes?.length || body.data.variants?.length) {
      await syncProductVariants(
        tx,
        p.id,
        BigInt(body.data.priceMinor),
        body.data.variantAxes,
        body.data.variants,
      );
    }
    return tx.product.findUnique({
      where: { id: p.id },
      include: { media: true, category: true, store: true, variants: { where: { active: true } }, parcelType: true },
    });
  });
  const publishNote = canPublishLive
    ? undefined
    : "Product saved as draft. It will go live automatically once your seller account is approved.";
  return ok(res, { ...serialize(product), publishNote }, 201);
});

marketRouter.patch("/seller/products/:id", requireAuth, requireSellerKyb, async (req, res) => {
  const store = await sellerStoreFor(req.user!.id);
  if (!store) return fail(res, 404, "NO_STORE", "No seller store");
  const existing = await prisma.product.findFirst({ where: { id: param(req, "id"), storeId: store.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Product not found");
  const body = z
    .object({
      title: z.string().min(2).optional(),
      ...sellerProductPatchFields,
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", validationMessage(body.error));
  const product = await prisma.$transaction(async (tx) => {
    const p = await tx.product.update({
      where: { id: existing.id },
      data: {
        ...(body.data.title !== undefined ? { title: body.data.title } : {}),
        ...(body.data.description !== undefined ? { description: body.data.description } : {}),
        ...(body.data.priceMinor !== undefined ? { priceMinor: BigInt(body.data.priceMinor) } : {}),
        ...(body.data.imageUrl !== undefined ? { imageUrl: body.data.imageUrl } : {}),
        ...(body.data.moq !== undefined ? { moq: body.data.moq } : {}),
        ...(body.data.categoryId !== undefined ? { categoryId: body.data.categoryId } : {}),
        ...(body.data.active !== undefined ? { active: body.data.active } : {}),
        ...(body.data.stock !== undefined ? { stock: body.data.stock } : {}),
        ...(body.data.variantAxes !== undefined ? { variantAxes: body.data.variantAxes } : {}),
        ...(body.data.pricingTiers !== undefined ? { pricingTiers: body.data.pricingTiers } : {}),
        ...(body.data.cbmPerUnit !== undefined ? { cbmPerUnit: body.data.cbmPerUnit } : {}),
        ...(body.data.weightKgPerUnit !== undefined ? { weightKgPerUnit: body.data.weightKgPerUnit } : {}),
        ...(body.data.originHub !== undefined ? { originHub: body.data.originHub } : {}),
        ...(body.data.leadTimeMin !== undefined ? { leadTimeMin: body.data.leadTimeMin } : {}),
        ...(body.data.leadTimeMax !== undefined ? { leadTimeMax: body.data.leadTimeMax } : {}),
        ...(body.data.packagingType !== undefined ? { packagingType: body.data.packagingType } : {}),
        ...(body.data.defaultIncoterm !== undefined ? { defaultIncoterm: body.data.defaultIncoterm } : {}),
        ...(body.data.parcelTypeId !== undefined ? { parcelTypeId: body.data.parcelTypeId } : {}),
      },
    });
    if (body.data.mediaUrls) {
      await tx.productMedia.deleteMany({ where: { productId: p.id } });
      for (let i = 0; i < body.data.mediaUrls.length; i++) {
        await tx.productMedia.create({
          data: { productId: p.id, url: body.data.mediaUrls[i], sortOrder: i },
        });
      }
      if (body.data.mediaUrls[0] && body.data.imageUrl === undefined) {
        await tx.product.update({ where: { id: p.id }, data: { imageUrl: body.data.mediaUrls[0] } });
      }
    }
    if (body.data.variantAxes !== undefined || body.data.variants !== undefined) {
      const axes = (body.data.variantAxes ?? (existing.variantAxes as VariantAxis[] | null) ?? undefined) as
        | VariantAxis[]
        | undefined;
      await syncProductVariants(
        tx,
        p.id,
        body.data.priceMinor !== undefined ? BigInt(body.data.priceMinor) : existing.priceMinor,
        axes,
        body.data.variants,
      );
    }
    return tx.product.findUnique({
      where: { id: p.id },
      include: { media: true, category: true, variants: { where: { active: true } } },
    });
  });
  return ok(res, serialize(product));
});

marketRouter.delete("/seller/products/:id", requireAuth, async (req, res) => {
  const store = await sellerStoreFor(req.user!.id);
  if (!store) return fail(res, 404, "NO_STORE", "No seller store");
  const existing = await prisma.product.findFirst({ where: { id: param(req, "id"), storeId: store.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Product not found");
  await prisma.product.update({ where: { id: existing.id }, data: { active: false } });
  return ok(res, { id: existing.id, active: false });
});

/* ─── Seller orders ────────────────────────────────────────────────── */

marketRouter.get("/seller/orders", requireAuth, async (req, res) => {
  const store = await sellerStoreFor(req.user!.id);
  if (!store) return ok(res, []);
  const orders = await prisma.marketOrder.findMany({
    where: { OR: [{ supplier: store.id }, { supplier: store.name }] },
    include: {
      items: true,
      user: { select: { id: true, name: true, phone: true, avatarUrl: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(orders));
});

marketRouter.get("/seller/orders/:id", requireAuth, async (req, res) => {
  const store = await sellerStoreFor(req.user!.id);
  if (!store) return fail(res, 404, "NOT_FOUND", "Order not found");
  const order = await prisma.marketOrder.findFirst({
    where: { id: param(req, "id"), OR: [{ supplier: store.id }, { supplier: store.name }] },
    include: {
      items: { include: { product: true } },
      user: { select: { id: true, name: true, phone: true, avatarUrl: true, email: true } },
    },
  });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  return ok(res, serialize(order));
});

marketRouter.patch("/seller/orders/:id", requireAuth, requireSellerKyb, async (req, res) => {
  const store = await sellerStoreFor(req.user!.id);
  if (!store) return fail(res, 404, "NOT_FOUND", "Order not found");
  const body = z
    .object({
      status: z.enum(["IN_ESCROW", "SHIPPED", "DELIVERED", "DISPUTED", "CANCELLED"]).optional(),
      tracking: z.string().optional(),
      carrier: z.string().optional(),
      note: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid update");
  const order = await prisma.marketOrder.findFirst({
    where: { id: param(req, "id"), OR: [{ supplier: store.id }, { supplier: store.name }] },
  });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  if (body.data.status === "SHIPPED") {
    const tracking = body.data.tracking ?? order.tracking;
    if (!tracking?.trim()) {
      return fail(res, 400, "TRACKING_REQUIRED", "Enter tracking / B/L before marking shipped");
    }
    const meta = await sellerMeta(req.user!.id);
    const docs = ((meta.orderDocs as Record<string, unknown[]>) ?? {})[order.id] ?? [];
    if (!docs.length) {
      return fail(res, 400, "DOCS_REQUIRED", "Upload shipping documents before dispatch");
    }
  }
  if (body.data.status === "SHIPPED" && !["IN_ESCROW", "SHIPPED"].includes(order.status)) {
    return fail(res, 400, "BAD_STATUS", `Cannot mark shipped from ${order.status}`);
  }
  if (body.data.status === "DELIVERED") {
    return fail(
      res,
      403,
      "FORBIDDEN",
      "Sellers cannot mark delivered — the buyer confirms receipt via proof of delivery",
    );
  }
  const updated = await prisma.marketOrder.update({
    where: { id: order.id },
    data: {
      ...(body.data.status ? { status: body.data.status } : {}),
      ...(body.data.tracking !== undefined ? { tracking: body.data.tracking || null } : {}),
      ...(body.data.carrier !== undefined ? { carrier: body.data.carrier || null } : {}),
      ...(body.data.note !== undefined && body.data.note
        ? {
            sellerNote: order.sellerNote ? `${order.sellerNote}\n${body.data.note}` : body.data.note,
          }
        : {}),
    },
    include: { items: true, user: { select: { id: true, name: true, phone: true } } },
  });
  const title =
    body.data.status === "SHIPPED"
      ? "Seller marked order as shipped"
      : "Order update";
  const notifBody = [
    body.data.status ? `Status: ${body.data.status}` : null,
    body.data.carrier ? `Carrier: ${body.data.carrier}` : null,
    body.data.tracking ? `Tracking: ${body.data.tracking}` : null,
    body.data.note,
  ]
    .filter(Boolean)
    .join(" · ") || title;
  notifyUser(order.userId, {
    title,
    body: notifBody,
    href: `/market/order/${order.id}`,
    emailPref: "emailEscrow",
    emailSubject: title,
    emailText: mpEmail(null, [notifBody]),
  });
  if (body.data.status === "SHIPPED" && updated.shipmentId) {
    try {
      const linked = await prisma.shipment.findUnique({ where: { id: updated.shipmentId } });
      if (linked?.status === "HOLD_LOCKED") {
        await advanceShipmentOps({
          shipmentId: linked.id,
          status: "IN_TRANSIT",
          message: `Seller marked shipped${body.data.tracking || updated.tracking ? ` · ${body.data.tracking || updated.tracking}` : ""}`,
          skipSellerShipCheck: true,
          actor: "admin",
        });
      }
    } catch {
      // Shipment advance is best-effort; order status is already saved.
    }
  }
  return ok(res, serialize(updated));
});

async function sellerMeta(userId: string) {
  const bp = await prisma.businessProfile.findUnique({ where: { userId } });
  return (bp?.documents as Record<string, unknown> | null) ?? {};
}

async function saveSellerMeta(userId: string, patch: Record<string, unknown>) {
  const existing = await sellerMeta(userId);
  const merged = { ...existing, ...patch };
  const bp = await prisma.businessProfile.findUnique({ where: { userId }, select: { status: true, companyName: true } });
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const companyName = bp?.companyName?.trim() || user?.name?.trim() || "Seller business";
  await prisma.businessProfile.upsert({
    where: { userId },
    create: { userId, companyName, documents: inputJson(merged), status: "DRAFT" },
    update: {
      documents: inputJson(merged),
      ...(bp?.status === "DRAFT" || !bp ? { companyName } : {}),
    },
  });
  return merged;
}

async function maybeIssueFapiao(sellerUserId: string, order: { id: string; userId: string; totalMinor: bigint; currency: string }) {
  const meta = await sellerMeta(sellerUserId);
  if (meta.autoFapiao === false) return null;
  const existing = await prisma.fapiao.findFirst({ where: { orderId: order.id } });
  if (existing) return existing;
  const bp = await prisma.businessProfile.findUnique({ where: { userId: sellerUserId } });
  return prisma.fapiao.create({
    data: {
      sellerUserId,
      buyerUserId: order.userId,
      orderId: order.id,
      amountMinor: order.totalMinor,
      currency: order.currency as "NGN" | "CNY" | "USD",
      vatRate: (meta.vatRate as string) ?? "13",
      uscc: (meta.uscc as string) ?? bp?.licenseNo ?? null,
      status: "issued",
    },
  });
}

marketRouter.get("/seller/templates", requireAuth, async (req, res) => {
  await ensureSellerStore(req.user!.id);
  const meta = await sellerMeta(req.user!.id);
  const templates = (meta.templates as unknown[]) ?? [];
  return ok(res, templates);
});

marketRouter.put("/seller/templates", requireAuth, requireSellerKyb, async (req, res) => {
  const body = z.object({ templates: z.array(z.object({ id: z.string(), title: z.string(), body: z.string() })) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid templates");
  await saveSellerMeta(req.user!.id, { templates: body.data.templates });
  return ok(res, body.data.templates);
});

marketRouter.get("/seller/orders/:id/documents", requireAuth, async (req, res) => {
  const store = await sellerStoreFor(req.user!.id);
  if (!store) return fail(res, 404, "NOT_FOUND", "Order not found");
  const order = await prisma.marketOrder.findFirst({
    where: { id: param(req, "id"), OR: [{ supplier: store.id }, { supplier: store.name }] },
  });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  const payload = await orderDocumentsForSeller(req.user!.id, order.id);
  return ok(res, serialize(payload));
});

marketRouter.post("/seller/orders/:id/documents", requireAuth, requireSellerKyb, async (req, res) => {
  const store = await sellerStoreFor(req.user!.id);
  if (!store) return fail(res, 404, "NOT_FOUND", "Order not found");
  const body = z.object({ kind: z.string(), name: z.string(), url: z.string().min(4) }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid document");
  const order = await prisma.marketOrder.findFirst({
    where: { id: param(req, "id"), OR: [{ supplier: store.id }, { supplier: store.name }] },
  });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  const meta = await sellerMeta(req.user!.id);
  const all = { ...((meta.orderDocs as Record<string, unknown[]>) ?? {}) };
  const list = [...(all[order.id] ?? []), { ...body.data, uploadedAt: new Date().toISOString() }];
  all[order.id] = list;
  await saveSellerMeta(req.user!.id, { orderDocs: all });
  notifyUser(order.userId, {
    title: "New shipping document",
    body: `${body.data.name} · order ${order.id.slice(0, 8)}`,
    href: `/market/order/${order.id}`,
    emailPref: "emailEscrow",
    emailSubject: "New shipping document",
    emailText: mpEmail(null, [`${body.data.name} was uploaded for order ${order.id.slice(0, 8)}.`]),
  });
  return ok(res, list[list.length - 1], 201);
});

marketRouter.post("/seller/orders/:id/documents/send", requireAuth, requireSellerKyb, async (req, res) => {
  const store = await sellerStoreFor(req.user!.id);
  if (!store) return fail(res, 404, "NOT_FOUND", "Order not found");
  const order = await prisma.marketOrder.findFirst({
    where: { id: param(req, "id"), OR: [{ supplier: store.id }, { supplier: store.name }] },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");

  const { documents } = await orderDocumentsForSeller(req.user!.id, order.id);
  const uploadedKinds = new Set(documents.map((d) => d.kind));
  const missing = REQUIRED_SELLER_DOC_KINDS.filter((k) => !uploadedKinds.has(k));
  if (missing.length) {
    return fail(res, 400, "DOCS_INCOMPLETE", `Upload required docs first: ${missing.join(", ")}`);
  }

  const sentAt = new Date().toISOString();
  const meta = await sellerMeta(req.user!.id);
  const sentMap = { ...((meta.orderDocPackageSent as Record<string, string>) ?? {}), [order.id]: sentAt };
  await saveSellerMeta(req.user!.id, { orderDocPackageSent: sentMap });

  const docList = documents.map((d) => d.name).join(", ");
  notifyUser(order.userId, {
    title: "Shipping doc package ready",
    body: `${store.name} sent ${documents.length} documents for order ${order.id.slice(0, 8)}: ${docList}`,
    href: `/market/order/${order.id}`,
    emailPref: "emailEscrow",
    emailSubject: "Shipping doc package ready",
    emailText: mpEmail(null, [`${store.name} sent ${documents.length} documents for order ${order.id.slice(0, 8)}: ${docList}`]),
  });

  return ok(
    res,
    serialize({
      sentAt,
      documents,
    }),
  );
});

/* ─── Cart ─────────────────────────────────────────────────────────── */

marketRouter.get("/cart", requireAuth, async (req, res) => {
  let cart = await prisma.cart.findUnique({
    where: { userId: req.user!.id },
    include: { items: { include: { product: true, variant: true } } },
  });
  if (!cart) {
    cart = await prisma.cart.create({
      data: { userId: req.user!.id },
      include: { items: { include: { product: true, variant: true } } },
    });
  }
  return ok(res, serialize(cart));
});

marketRouter.post("/cart/items", requireAuth, async (req, res) => {
  const body = z
    .object({
      productId: z.string().uuid(),
      qty: z.number().int().positive().default(1),
      variantId: z.string().uuid().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid cart item");
  const product = await prisma.product.findUnique({
    where: { id: body.data.productId, active: true },
    include: { variants: { where: { active: true } } },
  });
  if (!product) return fail(res, 404, "NOT_FOUND", "Product not found");

  let variantId: string | null = null;
  let variantKey = "";
  if (product.variants.length) {
    if (!body.data.variantId) return fail(res, 400, "VARIANT_REQUIRED", "Select a variant");
    const variant = product.variants.find((v) => v.id === body.data.variantId);
    if (!variant) return fail(res, 400, "INVALID_VARIANT", "Variant not found");
    variantId = variant.id;
    variantKey = variantKeyFromOptions(variant.options as VariantOptions);
    if (variant.stock != null && variant.stock < body.data.qty) {
      return fail(res, 400, "OUT_OF_STOCK", "Not enough stock for this variant");
    }
  } else if (body.data.variantId) {
    return fail(res, 400, "NO_VARIANTS", "Product has no variants");
  } else if (product.stock != null && product.stock < body.data.qty) {
    return fail(res, 400, "OUT_OF_STOCK", "Not enough stock");
  }

  let cart = await prisma.cart.findUnique({ where: { userId: req.user!.id } });
  if (!cart) cart = await prisma.cart.create({ data: { userId: req.user!.id } });
  const item = await prisma.cartItem.upsert({
    where: {
      cartId_productId_variantKey: { cartId: cart.id, productId: product.id, variantKey },
    },
    create: {
      cartId: cart.id,
      productId: product.id,
      variantId,
      variantKey,
      qty: body.data.qty,
    },
    update: { qty: { increment: body.data.qty } },
    include: { product: true, variant: true },
  });
  return ok(res, serialize(item), 201);
});

marketRouter.patch("/cart/items/:id", requireAuth, async (req, res) => {
  const body = z.object({ qty: z.number().int().positive() }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid qty");
  const cart = await prisma.cart.findUnique({ where: { userId: req.user!.id } });
  if (!cart) return fail(res, 404, "NOT_FOUND", "Cart not found");
  const existing = await prisma.cartItem.findFirst({ where: { id: param(req, "id"), cartId: cart.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Item not found");
  const item = await prisma.cartItem.update({
    where: { id: existing.id },
    data: { qty: body.data.qty },
    include: { product: true, variant: true },
  });
  return ok(res, serialize(item));
});

marketRouter.delete("/cart/items/:id", requireAuth, async (req, res) => {
  const cart = await prisma.cart.findUnique({ where: { userId: req.user!.id } });
  if (!cart) return fail(res, 404, "NOT_FOUND", "Cart not found");
  const existing = await prisma.cartItem.findFirst({ where: { id: param(req, "id"), cartId: cart.id } });
  if (!existing) return fail(res, 404, "NOT_FOUND", "Item not found");
  await prisma.cartItem.delete({ where: { id: existing.id } });
  return ok(res, { id: existing.id, deleted: true });
});

marketRouter.post("/checkout", requireAuth, async (req, res) => {
  const body = z
    .object({
      addressLabel: z.string().optional(),
      addressLine: z.string().optional(),
      deliveryMethod: z.enum(["PICKUP", "DOORSTEP"]).optional(),
    })
    .safeParse(req.body ?? {});
  const cart = await prisma.cart.findUnique({
    where: { userId: req.user!.id },
    include: { items: { include: { product: { include: { store: true } }, variant: true } } },
  });
  if (!cart?.items.length) return fail(res, 400, "EMPTY_CART", "Cart is empty");

  const storeIds = [...new Set(cart.items.map((i) => i.product.storeId))];
  if (storeIds.length > 1) {
    return fail(res, 400, "MIXED_CART", "Remove items from other suppliers before checkout");
  }

  const currency = cart.items[0].product.currency;
  const goodsMinor = cart.items.reduce(
    (s, i) => s + unitMinorForCartItem(i) * BigInt(i.qty),
    0n,
  );
  const feeMinor = BigInt(Math.floor(Number(goodsMinor) * 0.009));
  const totalMinor = goodsMinor + feeMinor;
  const supplier = storeIds[0]!;
  const sellerUserId = cart.items[0].product.store.userId;
  const orderTitle =
    cart.items.length === 1
      ? cart.items[0].product.title
      : `${cart.items.length} items · ${cart.items[0].product.title}`;

  try {
    await assertKycForAction(req.user!.id, "market_checkout");
    const order = await prisma.$transaction(async (tx) => {
      await lockToHold(
        tx,
        req.user!.id,
        currency,
        totalMinor,
        "ESCROW_HOLD",
        "Market checkout escrow",
      );
      const escrow = await tx.escrow.create({
        data: {
          title: orderTitle,
          buyerId: req.user!.id,
          sellerId: sellerUserId,
          amountMinor: totalMinor,
          currency,
          status: "ACTIVE",
          progress: 1,
        },
      });
      await tx.escrowMilestone.create({
        data: {
          escrowId: escrow.id,
          label: "Order total · held in escrow",
          amountMinor: totalMinor,
          sortOrder: 0,
          status: "FUNDED",
        },
      });
      const o = await tx.marketOrder.create({
        data: {
          userId: req.user!.id,
          status: "IN_ESCROW",
          totalMinor,
          currency,
          supplier,
          escrowId: escrow.id,
          deliveryMethod: body.success && body.data.deliveryMethod ? body.data.deliveryMethod : "PICKUP",
          deliveryAddress:
            body.success && (body.data.addressLabel || body.data.addressLine)
              ? { addressLabel: body.data.addressLabel ?? null, addressLine: body.data.addressLine ?? null }
              : undefined,
          logisticsStatus: "NOT_BOOKED",
          items: {
            create: cart.items.map((i) => {
              const unitMinor = unitMinorForCartItem(i);
              const variantLabel = i.variant
                ? variantLabelFromOptions(i.variant.options as VariantOptions)
                : null;
              return {
                productId: i.productId,
                variantId: i.variantId,
                variantLabel,
                title: variantLabel ? `${i.product.title} (${variantLabel})` : i.product.title,
                qty: i.qty,
                priceMinor: unitMinor,
              };
            }),
          },
        },
        include: { items: true },
      });
      for (const item of cart.items) {
        const unitMinor = unitMinorForCartItem(item);
        if (item.variantId && item.variant?.stock != null) {
          if (item.variant.stock < item.qty) {
            throw new Error(`Insufficient stock for ${item.product.title}`);
          }
          await tx.productVariant.update({
            where: { id: item.variantId },
            data: { stock: item.variant.stock - item.qty },
          });
        } else if (item.product.stock != null) {
          if (item.product.stock < item.qty) {
            throw new Error(`Insufficient stock for ${item.product.title}`);
          }
          await tx.product.update({
            where: { id: item.productId },
            data: { stock: item.product.stock - item.qty },
          });
        }
      }
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await recordTx(tx, {
        userId: req.user!.id,
        kind: "order",
        title: `Order ${o.id.slice(0, 8)}`,
        currency,
        amountDisplay: `−${formatMoney(currency, totalMinor)}`,
        amountPositive: false,
        status: "COMPLETED",
        icon: "package",
      });
      await recordTx(tx, {
        userId: req.user!.id,
        kind: "escrow",
        title: orderTitle,
        currency,
        amountDisplay: formatMoney(currency, totalMinor),
        amountPositive: false,
        status: "COMPLETED",
        icon: "shield",
      });
      return { ...o, escrowId: escrow.id };
    });
    notifyUser(sellerUserId, {
      title: "New market order",
      body: `${orderTitle} · ${formatMoney(currency, totalMinor)}`,
      href: `/market/order/${order.id}`,
      emailPref: "emailEscrow",
      emailSubject: "New market order",
      emailText: mpEmail(null, [`You received a new order: ${orderTitle} · ${formatMoney(currency, totalMinor)}.`]),
    });
    if (body.success && (body.data.addressLabel || body.data.addressLine)) {
      const prefBody = [
        body.data.deliveryMethod === "DOORSTEP" ? "Doorstep delivery" : "Warehouse pickup",
        body.data.addressLabel,
        body.data.addressLine,
      ]
        .filter(Boolean)
        .join(" · ");
      notifyUser(req.user!.id, {
        title: "Delivery preference saved",
        body: prefBody,
        href: `/market/order/${order.id}`,
      });
    }
    return ok(res, serialize(order), 201);
  } catch (e) {
    if (e instanceof KycRequiredError) return fail(res, 403, "KYC_REQUIRED", e.message);
    return fail(res, 400, "CHECKOUT_FAILED", e instanceof Error ? e.message : "Checkout failed");
  }
});

/* ─── Buyer orders ─────────────────────────────────────────────────── */

marketRouter.get("/orders", requireAuth, async (req, res) => {
  const orders = await prisma.marketOrder.findMany({
    where: { userId: req.user!.id },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(orders));
});

marketRouter.get("/orders/:id", requireAuth, async (req, res) => {
  const order = await prisma.marketOrder.findFirst({
    where: { id: param(req, "id"), userId: req.user!.id },
    include: {
      items: { include: { product: true, variant: true } },
      shipment: { select: { id: true, ref: true, route: true, status: true, eta: true } },
    },
  });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  return ok(
    res,
    serialize({
      ...order,
      shipment: shipmentSummary(order.shipment),
      logisticsNextAction: orderLogisticsNextAction(order),
    }),
  );
});

marketRouter.get("/orders/:id/documents", requireAuth, async (req, res) => {
  const order = await prisma.marketOrder.findFirst({
    where: { id: param(req, "id"), userId: req.user!.id },
  });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  const payload = await orderDocumentsForBuyer(order.id);
  return ok(res, serialize(payload));
});

marketRouter.post("/orders/:id/reorder", requireAuth, async (req, res) => {
  const orderId = String(param(req, "id"));
  const order = await prisma.marketOrder.findFirst({
    where: { id: orderId, userId: req.user!.id },
    include: { items: true },
  });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  if (!order.items.length) return fail(res, 400, "EMPTY_ORDER", "Order has no line items");

  const cart = await prisma.cart.upsert({
    where: { userId: req.user!.id },
    create: { userId: req.user!.id },
    update: {},
  });

  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  for (const line of order.items) {
    const product = await prisma.product.findFirst({
      where: { id: line.productId, active: true },
    });
    if (!product) continue;
    let variantId: string | null = line.variantId;
    let variantKey = "";
    if (variantId) {
      const variant = await prisma.productVariant.findFirst({
        where: { id: variantId, productId: line.productId, active: true },
      });
      if (!variant) {
        variantId = null;
      } else {
        variantKey = variantKeyFromOptions(variant.options as VariantOptions);
      }
    }
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId: line.productId,
        variantId,
        variantKey,
        qty: line.qty,
      },
    });
  }

  const rebuilt = await prisma.cart.findUnique({
    where: { id: cart.id },
    include: { items: { include: { product: { include: { store: true } }, variant: true } } },
  });
  if (!rebuilt?.items.length) {
    return fail(res, 400, "UNAVAILABLE", "None of the original products are available");
  }
  return ok(res, serialize(rebuilt));
});

/** Buyer confirms receipt. With a linked shipment, POD must complete first. Without shipment, this marks the order delivered. */
marketRouter.post("/orders/:id/confirm-delivery", requireAuth, async (req, res) => {
  const order = await prisma.marketOrder.findFirst({
    where: { id: param(req, "id"), userId: req.user!.id },
  });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  if (order.status === "DELIVERED" || order.status === "COMPLETED") {
    return ok(res, serialize(order));
  }
  if (order.status !== "SHIPPED") {
    return fail(res, 400, "BAD_STATUS", "Order must be shipped before confirming delivery");
  }
  if (order.shipmentId) {
    const shipment = await prisma.shipment.findUnique({ where: { id: order.shipmentId } });
    if (shipment?.status !== "DELIVERED") {
      return fail(
        res,
        400,
        "POD_REQUIRED",
        "Complete proof of delivery on your shipment before confirming receipt",
      );
    }
    return ok(res, serialize(order));
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.marketOrder.update({
      where: { id: order.id },
      data: { status: "DELIVERED", logisticsStatus: "DELIVERED" },
    });
    if (order.escrowId) {
      await tx.escrowMilestone.updateMany({
        where: { escrowId: order.escrowId, status: "FUNDED", releaseRequestedAt: null },
        data: { releaseRequestedAt: new Date() },
      });
    }
    return row;
  });
  return ok(res, serialize(updated));
});

marketRouter.post("/orders/:id/release", requireAuth, async (req, res) => {
  const order = await prisma.marketOrder.findFirst({
    where: { id: param(req, "id"), userId: req.user!.id },
  });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  if (order.status === "COMPLETED") return ok(res, serialize(order));
  if (!["DELIVERED", "COMPLETED"].includes(order.status)) {
    return fail(
      res,
      400,
      "NOT_READY",
      order.status === "SHIPPED"
        ? "Confirm proof of delivery before releasing funds"
        : "Seller must mark this order as shipped before you can release funds",
    );
  }
  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (order.escrowId) {
        const escrow = await tx.escrow.findUnique({
          where: { id: order.escrowId },
          include: { milestones: true },
        });
        const ms = escrow?.milestones.find((m) => m.status === "FUNDED");
        if (escrow?.sellerId && ms) {
          await settleEscrowRelease(
            tx,
            order.userId,
            escrow.sellerId,
            escrow.currency,
            ms.amountMinor,
            `Release ${ms.label}`,
            ms.id,
          );
          await tx.escrowMilestone.update({ where: { id: ms.id }, data: { status: "RELEASED" } });
          const remaining = await tx.escrowMilestone.count({
            where: { escrowId: escrow.id, status: { not: "RELEASED" } },
          });
          await tx.escrow.update({
            where: { id: escrow.id },
            data: { status: remaining === 0 ? "COMPLETED" : "ACTIVE", progress: remaining === 0 ? 1 : 0.75 },
          });
        }
      }
      return tx.marketOrder.update({
        where: { id: order.id },
        data: { status: "COMPLETED" },
        include: { items: true },
      });
    });
    const store = await prisma.sellerStore.findFirst({
      where: { OR: [{ id: order.supplier }, { name: order.supplier }] },
      select: { userId: true },
    });
    if (store) {
      notifyUser(store.userId, {
        title: "Funds released",
        body: `Buyer released order ${order.id.slice(0, 8)}`,
        href: `/market/order/${order.id}`,
        emailPref: "emailEscrow",
        emailSubject: "Funds released",
        emailText: mpEmail(null, [`Buyer released funds for order ${order.id.slice(0, 8)}.`]),
      });
      await maybeIssueFapiao(store.userId, order).catch(() => null);
    }
    return ok(res, serialize(updated));
  } catch (e) {
    return fail(res, 400, "RELEASE_FAILED", e instanceof Error ? e.message : "Release failed");
  }
});

marketRouter.post("/orders/:id/dispute", requireAuth, async (req, res) => {
  const body = z
    .object({ reason: z.string().min(5), category: z.string().optional() })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid dispute");
  const order = await prisma.marketOrder.findFirst({
    where: { id: param(req, "id"), userId: req.user!.id },
  });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  const updated = await prisma.marketOrder.update({
    where: { id: order.id },
    data: { status: "DISPUTED" },
    include: { items: true },
  });
  const store = await prisma.sellerStore.findUnique({ where: { id: order.supplier } });
  if (store) {
    notifyUser(store.userId, {
      title: "Order disputed",
      body: body.data.reason.slice(0, 120),
      href: `/market/order/${order.id}`,
      emailPref: "emailEscrow",
      emailSubject: "Order disputed",
      emailText: mpEmail(null, [`Order ${order.id.slice(0, 8)} was disputed: ${body.data.reason.slice(0, 200)}`]),
    });
  }
  return ok(res, serialize(updated));
});

marketRouter.post("/orders/:id/reviews", requireAuth, async (req, res) => {
  const body = z
    .object({
      productId: z.string().uuid().optional(),
      rating: z.number().int().min(1).max(5),
      comment: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid review");
  const order = await prisma.marketOrder.findFirst({
    where: { id: param(req, "id"), userId: req.user!.id },
    include: { items: true },
  });
  if (!order) return fail(res, 404, "NOT_FOUND", "Order not found");
  const productId = body.data.productId || order.items[0]?.productId;
  if (!productId) return fail(res, 400, "NO_PRODUCT", "No product on order");
  const review = await prisma.review.create({
    data: {
      userId: req.user!.id,
      productId,
      rating: body.data.rating,
      comment: body.data.comment,
    },
    include: { user: { select: { id: true, name: true, avatarUrl: true } } },
  });
  const agg = await prisma.review.aggregate({
    where: { productId },
    _avg: { rating: true },
  });
  if (agg._avg.rating != null) {
    await prisma.product.update({
      where: { id: productId },
      data: { rating: Math.round(agg._avg.rating * 10) / 10 },
    });
  }
  if (order.status === "SHIPPED" || order.status === "IN_ESCROW") {
    await prisma.marketOrder.update({ where: { id: order.id }, data: { status: "COMPLETED" } });
  }
  return ok(res, serialize(review), 201);
});

/* ─── Wishlist ─────────────────────────────────────────────────────── */

marketRouter.get("/wishlist", requireAuth, async (req, res) => {
  const rows = await prisma.wishlistItem.findMany({
    where: { userId: req.user!.id },
    include: { product: { include: { store: true } } },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(rows));
});

marketRouter.post("/wishlist", requireAuth, async (req, res) => {
  const body = z.object({ productId: z.string().uuid() }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid product");
  const row = await prisma.wishlistItem.upsert({
    where: { userId_productId: { userId: req.user!.id, productId: body.data.productId } },
    create: { userId: req.user!.id, productId: body.data.productId },
    update: {},
    include: { product: true },
  });
  return ok(res, serialize(row), 201);
});

marketRouter.delete("/wishlist/:productId", requireAuth, async (req, res) => {
  await prisma.wishlistItem.deleteMany({
    where: { userId: req.user!.id, productId: param(req, "productId") },
  });
  return ok(res, { deleted: true });
});

/* ─── Favorite suppliers ───────────────────────────────────────────── */

marketRouter.get("/favorite-sellers", requireAuth, async (req, res) => {
  const rows = await prisma.favoriteSupplier.findMany({
    where: { userId: req.user!.id },
    include: { store: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } } },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(rows));
});

marketRouter.post("/favorite-sellers", requireAuth, async (req, res) => {
  const body = z.object({ sellerStoreId: z.string().uuid() }).safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "sellerStoreId required");
  const store = await prisma.sellerStore.findUnique({ where: { id: body.data.sellerStoreId } });
  if (!store) return fail(res, 404, "NOT_FOUND", "Store not found");
  const row = await prisma.favoriteSupplier.upsert({
    where: {
      userId_sellerStoreId: { userId: req.user!.id, sellerStoreId: body.data.sellerStoreId },
    },
    create: { userId: req.user!.id, sellerStoreId: body.data.sellerStoreId },
    update: {},
    include: { store: true },
  });
  return ok(res, serialize(row), 201);
});

marketRouter.delete("/favorite-sellers/:sellerStoreId", requireAuth, async (req, res) => {
  await prisma.favoriteSupplier.deleteMany({
    where: { userId: req.user!.id, sellerStoreId: String(param(req, "sellerStoreId")) },
  });
  return ok(res, { deleted: true });
});

marketRouter.get("/seller/settings", requireAuth, async (req, res) => {
  const meta = await sellerMeta(req.user!.id);
  const bp = await prisma.businessProfile.findUnique({ where: { userId: req.user!.id } });
  return ok(res, {
    invoiceFooter: (meta.invoiceFooter as string) ?? "",
    vatInclusive: Boolean(meta.vatInclusive),
    autoFapiao: meta.autoFapiao !== false,
    uscc: (meta.uscc as string) ?? bp?.licenseNo ?? "",
    vatRate: (meta.vatRate as string) ?? "13",
  });
});

marketRouter.patch("/seller/settings", requireAuth, async (req, res) => {
  const body = z
    .object({
      invoiceFooter: z.string().optional(),
      vatInclusive: z.boolean().optional(),
      autoFapiao: z.boolean().optional(),
      uscc: z.string().optional(),
      vatRate: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid settings");
  await saveSellerMeta(req.user!.id, body.data);
  if (body.data.uscc !== undefined) {
    await prisma.businessProfile.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, companyName: "", licenseNo: body.data.uscc },
      update: { licenseNo: body.data.uscc },
    });
  }
  const meta = await sellerMeta(req.user!.id);
  const bp = await prisma.businessProfile.findUnique({ where: { userId: req.user!.id } });
  return ok(res, {
    invoiceFooter: (meta.invoiceFooter as string) ?? "",
    vatInclusive: Boolean(meta.vatInclusive),
    autoFapiao: meta.autoFapiao !== false,
    uscc: (meta.uscc as string) ?? bp?.licenseNo ?? "",
    vatRate: (meta.vatRate as string) ?? "13",
  });
});

/* ─── Seller team ──────────────────────────────────────────────────── */

marketRouter.get("/seller/team", requireAuth, async (req, res) => {
  const store = await sellerStoreFor(req.user!.id);
  if (!store) return fail(res, 404, "NO_STORE", "No seller store");
  const owner = await prisma.user.findUnique({
    where: { id: store.userId },
    select: { id: true, name: true, phone: true, email: true, avatarUrl: true },
  });
  const members = await prisma.sellerStoreMember.findMany({
    where: { storeId: store.id },
    include: { user: { select: { id: true, name: true, phone: true, email: true, avatarUrl: true } } },
    orderBy: { joinedAt: "asc" },
  });
  const pendingInvites = await prisma.sellerTeamInvite.findMany({
    where: { storeId: store.id, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, {
    members: [
      ...(owner ? [{ role: "OWNER", user: serialize(owner) }] : []),
      ...members.map((m) => ({ role: m.role, user: serialize(m.user) })),
    ],
    pendingInvites: serialize(pendingInvites),
  });
});

marketRouter.post("/seller/team", requireAuth, requireSellerKyb, async (req, res) => {
  const body = z
    .object({
      phone: z.string().min(8).optional(),
      email: z.string().email().optional(),
      role: z.enum(["OPS", "FINANCE", "VIEWER"]).default("OPS"),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "phone or email required");
  if (!body.data.phone && !body.data.email) {
    return fail(res, 400, "VALIDATION", "phone or email required");
  }
  const store = await ensureSellerStore(req.user!.id);
  if (store.userId !== req.user!.id) return fail(res, 403, "FORBIDDEN", "Only store owner can invite");
  const token = uuidv4();
  const invite = await prisma.sellerTeamInvite.create({
    data: {
      storeId: store.id,
      token,
      phone: body.data.phone ?? null,
      email: body.data.email ?? null,
      role: body.data.role,
      invitedById: req.user!.id,
      expiresAt: new Date(Date.now() + 14 * 86400000),
    },
  });
  if (body.data.phone) {
    const invitee = await prisma.user.findFirst({ where: { phone: body.data.phone } });
    if (invitee) {
      notifyUser(invitee.id, {
        title: "Seller team invite",
        body: `You were invited to ${store.name} as ${body.data.role}`,
        href: `/seller/team/accept?token=${token}`,
      });
    }
  }
  return ok(res, serialize(invite), 201);
});

marketRouter.get("/team/invites", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { phone: true, email: true },
  });
  if (!user) return ok(res, []);
  const invites = await prisma.sellerTeamInvite.findMany({
    where: {
      status: "pending",
      expiresAt: { gt: new Date() },
      OR: [
        ...(user.phone ? [{ phone: user.phone }] : []),
        ...(user.email ? [{ email: user.email }] : []),
      ],
    },
    include: { store: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(invites));
});

marketRouter.post("/team/invites/:token/accept", requireAuth, async (req, res) => {
  const token = String(param(req, "token"));
  const invite = await prisma.sellerTeamInvite.findUnique({ where: { token } });
  if (!invite || invite.status !== "pending") return fail(res, 404, "NOT_FOUND", "Invite not found");
  if (invite.expiresAt < new Date()) return fail(res, 410, "EXPIRED", "Invite expired");
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { phone: true, email: true },
  });
  const match =
    (invite.phone && user?.phone === invite.phone) || (invite.email && user?.email === invite.email);
  if (!match) return fail(res, 403, "FORBIDDEN", "Invite not for this account");
  await prisma.$transaction(async (tx) => {
    await tx.sellerStoreMember.upsert({
      where: { storeId_userId: { storeId: invite.storeId, userId: req.user!.id } },
      create: { storeId: invite.storeId, userId: req.user!.id, role: invite.role },
      update: { role: invite.role },
    });
    await tx.sellerTeamInvite.update({ where: { id: invite.id }, data: { status: "accepted" } });
  });
  return ok(res, { accepted: true, storeId: invite.storeId, role: invite.role });
});

/* ─── Fapiao ───────────────────────────────────────────────────────── */

marketRouter.get("/seller/fapiao", requireAuth, async (req, res) => {
  const rows = await prisma.fapiao.findMany({
    where: { sellerUserId: req.user!.id },
    include: { buyer: { select: { id: true, name: true, phone: true } } },
    orderBy: { issuedAt: "desc" },
    take: 50,
  });
  return ok(res, serialize(rows));
});

marketRouter.post("/seller/fapiao", requireAuth, requireSellerKyb, async (req, res) => {
  const body = z
    .object({
      orderId: z.string().uuid().optional(),
      amountMinor: z.union([z.string(), z.number()]).optional(),
      currency: z.enum(["NGN", "CNY", "USD"]).optional(),
      buyerUserId: z.string().uuid().optional(),
      documentUrl: z.string().url().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid fapiao");
  const meta = await sellerMeta(req.user!.id);
  const bp = await prisma.businessProfile.findUnique({ where: { userId: req.user!.id } });
  let order: { id: string; userId: string; totalMinor: bigint; currency: string } | null = null;
  if (body.data.orderId) {
    const store = await sellerStoreFor(req.user!.id);
    if (!store) return fail(res, 404, "NO_STORE", "No seller store");
    const o = await prisma.marketOrder.findFirst({
      where: { id: body.data.orderId, OR: [{ supplier: store.id }, { supplier: store.name }] },
    });
    if (!o) return fail(res, 404, "NOT_FOUND", "Order not found");
    order = o;
  }
  const row = await prisma.fapiao.create({
    data: {
      sellerUserId: req.user!.id,
      buyerUserId: body.data.buyerUserId ?? order?.userId ?? null,
      orderId: body.data.orderId ?? null,
      amountMinor: BigInt(body.data.amountMinor ?? order?.totalMinor ?? 0),
      currency: (body.data.currency ?? order?.currency ?? "CNY") as "NGN" | "CNY" | "USD",
      vatRate: (meta.vatRate as string) ?? "13",
      uscc: (meta.uscc as string) ?? bp?.licenseNo ?? null,
      documentUrl: body.data.documentUrl ?? null,
      status: "issued",
    },
  });
  return ok(res, serialize(row), 201);
});

/* ─── RFQ ──────────────────────────────────────────────────────────── */

marketRouter.post("/rfq", requireAuth, async (req, res) => {
  const body = z
    .object({
      title: z.string().min(2),
      description: z.string().optional(),
      qty: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid RFQ");
  const rfq = await prisma.rfq.create({
    data: { buyerId: req.user!.id, ...body.data },
  });
  const sellers = await prisma.user.findMany({
    where: { role: { in: ["SELLER", "BOTH"] } },
    take: 20,
    select: { id: true },
  });
  if (sellers.length) {
    notifyUsers(
      sellers.map((s) => s.id),
      {
        title: "New RFQ",
        body: rfq.title,
        href: `/market/rfq/${rfq.id}`,
      },
    );
  }
  return ok(res, serialize(rfq), 201);
});

marketRouter.get("/rfq", requireAuth, async (req, res) => {
  const rows = await prisma.rfq.findMany({
    where: { buyerId: req.user!.id },
    include: {
      quotes: {
        include: { seller: { select: { id: true, name: true, avatarUrl: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(rows));
});

marketRouter.get("/seller/rfq", requireAuth, async (req, res) => {
  const sellerId = req.user!.id;
  const rows = await prisma.rfq.findMany({
    where: {
      OR: [{ status: "open" }, { quotes: { some: { sellerId } } }],
    },
    include: {
      buyer: { select: { id: true, name: true, phone: true, avatarUrl: true } },
      quotes: { where: { sellerId } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return ok(res, serialize(rows));
});

marketRouter.get("/rfq/:id", requireAuth, async (req, res) => {
  const rfq = await prisma.rfq.findUnique({
    where: { id: param(req, "id") },
    include: {
      buyer: { select: { id: true, name: true, phone: true } },
      quotes: {
        include: { seller: { select: { id: true, name: true, avatarUrl: true } } },
      },
    },
  });
  if (!rfq) return fail(res, 404, "NOT_FOUND", "RFQ not found");
  const isBuyer = rfq.buyerId === req.user!.id;
  const isSeller = ["SELLER", "BOTH"].includes(
    (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { role: true } }))?.role ?? "",
  );
  if (!isBuyer && !isSeller) return fail(res, 403, "FORBIDDEN", "Not allowed");
  return ok(res, serialize(rfq));
});

marketRouter.post("/rfq/:id/quotes", requireAuth, requireSellerKyb, async (req, res) => {
  const body = z
    .object({
      amountMinor: z.union([z.string(), z.number()]),
      currency: z.enum(["NGN", "CNY", "USD"]).default("USD"),
      note: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid quote");
  const rfq = await prisma.rfq.findUnique({ where: { id: param(req, "id") } });
  if (!rfq) return fail(res, 404, "NOT_FOUND", "RFQ not found");
  const quote = await prisma.rfqQuote.create({
    data: {
      rfqId: rfq.id,
      sellerId: req.user!.id,
      amountMinor: BigInt(body.data.amountMinor),
      currency: body.data.currency,
      note: body.data.note,
    },
    include: { seller: { select: { id: true, name: true, avatarUrl: true } } },
  });
  notifyUser(rfq.buyerId, {
    title: "New quote on your RFQ",
    body: rfq.title,
    href: `/market/rfq/${rfq.id}`,
  });
  return ok(res, serialize(quote), 201);
});

marketRouter.get("/quotes/:id", requireAuth, async (req, res) => {
  const quote = await prisma.rfqQuote.findUnique({
    where: { id: param(req, "id") },
    include: {
      seller: { select: { id: true, name: true, avatarUrl: true, phone: true } },
      rfq: { include: { buyer: { select: { id: true, name: true } } } },
    },
  });
  if (!quote) return fail(res, 404, "NOT_FOUND", "Quote not found");
  if (quote.rfq.buyerId !== req.user!.id && quote.sellerId !== req.user!.id) {
    return fail(res, 403, "FORBIDDEN", "Not allowed");
  }
  return ok(res, serialize(quote));
});

marketRouter.get("/seller/quotes", requireAuth, async (req, res) => {
  const quotes = await prisma.rfqQuote.findMany({
    where: { sellerId: req.user!.id },
    include: {
      rfq: { include: { buyer: { select: { id: true, name: true, phone: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(quotes));
});
