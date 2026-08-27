import type { Currency } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { formatMoney } from "./ledger.js";
import { deliverUserNotification } from "./deliver.js";

export async function getConversationContext(conversationId: string, userId: string) {
  const part = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId },
  });
  if (!part) return null;

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      participants: { include: { user: { select: { id: true, name: true, phone: true, role: true } } } },
    },
  });
  if (!conv) return null;

  const peer = conv.participants.find((p) => p.userId !== userId)?.user ?? null;
  const me = conv.participants.find((p) => p.userId === userId)?.user ?? null;
  const product = conv.productId
    ? await prisma.product.findUnique({
        where: { id: conv.productId },
        include: { store: { select: { id: true, name: true, userId: true } } },
      })
    : null;

  let latestQuote = null;
  if (conv.latestQuoteId) {
    latestQuote = await prisma.rfqQuote.findUnique({
      where: { id: conv.latestQuoteId },
      include: {
        seller: { select: { id: true, name: true } },
        rfq: { select: { id: true, title: true, qty: true, description: true } },
      },
    });
  }

  const amSeller =
    me?.role === "SELLER" ||
    me?.role === "BOTH" ||
    (product?.store?.userId != null && product.store.userId === userId);

  return {
    conversation: conv,
    peer,
    product,
    latestQuote,
    amSeller,
  };
}

async function findOrCreateChatRfq(input: {
  buyerId: string;
  conversationId: string;
  productId?: string | null;
  subject?: string | null;
  qty?: string;
  productTitle?: string;
}) {
  if (input.productId) {
    const byProduct = await prisma.rfq.findFirst({
      where: {
        buyerId: input.buyerId,
        description: { contains: `product:${input.productId}` },
        status: "open",
      },
      orderBy: { createdAt: "desc" },
    });
    if (byProduct) return byProduct;
    return prisma.rfq.create({
      data: {
        buyerId: input.buyerId,
        title: input.productTitle || "Product quote",
        description: `Chat quote · product:${input.productId} · conversation:${input.conversationId}`,
        qty: input.qty,
        status: "open",
      },
    });
  }

  const byConv = await prisma.rfq.findFirst({
    where: {
      buyerId: input.buyerId,
      description: { contains: `conversation:${input.conversationId}` },
      status: "open",
    },
    orderBy: { createdAt: "desc" },
  });
  if (byConv) return byConv;

  return prisma.rfq.create({
    data: {
      buyerId: input.buyerId,
      title: input.subject || "Chat negotiation",
      description: `Chat quote · conversation:${input.conversationId}`,
      qty: input.qty,
      status: "open",
    },
  });
}

export async function upsertChatQuote(input: {
  conversationId: string;
  sellerId: string;
  amountMinor: bigint;
  currency: Currency;
  note?: string;
  qty?: string;
}) {
  const ctx = await getConversationContext(input.conversationId, input.sellerId);
  if (!ctx) throw new Error("Conversation not found");
  if (!ctx.amSeller) throw new Error("Only the supplier can update the quote");

  const buyerId = ctx.peer?.id;
  if (!buyerId) throw new Error("Buyer not found in conversation");

  const rfq = await findOrCreateChatRfq({
    buyerId,
    conversationId: input.conversationId,
    productId: ctx.conversation.productId,
    subject: ctx.conversation.subject,
    qty: input.qty ?? ctx.product?.moq ?? undefined,
    productTitle: ctx.product?.title,
  });

  const existing = await prisma.rfqQuote.findFirst({
    where: { rfqId: rfq.id, sellerId: input.sellerId },
  });

  const quote = existing
    ? await prisma.rfqQuote.update({
        where: { id: existing.id },
        data: {
          amountMinor: input.amountMinor,
          currency: input.currency,
          note: input.note,
        },
        include: {
          seller: { select: { id: true, name: true } },
          rfq: { select: { id: true, title: true, qty: true } },
        },
      })
    : await prisma.rfqQuote.create({
        data: {
          rfqId: rfq.id,
          sellerId: input.sellerId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          note: input.note,
        },
        include: {
          seller: { select: { id: true, name: true } },
          rfq: { select: { id: true, title: true, qty: true } },
        },
      });

  const display = formatMoney(input.currency, input.amountMinor);
  const msg = await prisma.$transaction(async (tx) => {
    await tx.conversation.update({
      where: { id: input.conversationId },
      data: {
        latestQuoteId: quote.id,
        productId: ctx.conversation.productId ?? ctx.product?.id ?? undefined,
        updatedAt: new Date(),
      },
    });
    return tx.message.create({
      data: {
        conversationId: input.conversationId,
        senderId: input.sellerId,
        body: existing ? `Quote updated · ${display} total` : `Quote sent · ${display} total`,
        quoteId: quote.id,
      },
      include: {
        quote: {
          include: {
            seller: { select: { id: true, name: true } },
            rfq: { select: { id: true, title: true, qty: true } },
          },
        },
      },
    });
  });

  void deliverUserNotification(buyerId, {
    title: existing ? "Quote updated" : "New quote in chat",
    body: `${ctx.product?.title ?? rfq.title} · ${display}`,
    href: `/messages/${input.conversationId}`,
  });

  return { quote, message: msg };
}
