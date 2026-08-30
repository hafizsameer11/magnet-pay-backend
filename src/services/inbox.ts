import type { PlatformRole, UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export type InboxTab = "quotes" | "orders" | "escrow";

export type InboxAttach = {
  kind: "quote" | "order" | "escrow";
  ref: string;
  meta: string;
  tab: InboxTab;
};

export function inboxPeerRole(
  peerRole: UserRole | undefined,
  peerPlatform: PlatformRole | undefined,
  amSeller: boolean,
): "Supplier" | "Buyer" | "Mediator" {
  if (peerPlatform === "ADMIN" || peerPlatform === "SUPER_ADMIN") return "Mediator";
  if (peerRole === "SELLER" || peerRole === "BOTH") return "Supplier";
  if (peerRole === "BUYER") return "Buyer";
  return amSeller ? "Buyer" : "Supplier";
}

export function shortRef(prefix: string, id: string) {
  return `${prefix}-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

function tabFromSubject(subject: string | null | undefined): InboxTab | null {
  const s = (subject ?? "").toLowerCase();
  if (s.includes("escrow") || s.includes("dispute") || s.includes("mediator")) return "escrow";
  if (s.includes("order")) return "orders";
  if (s.includes("quote") || s.includes("rfq")) return "quotes";
  return null;
}

export function attachFromSubject(subject: string | null | undefined): InboxAttach | null {
  const tab = tabFromSubject(subject);
  if (!tab) return null;
  const s = subject ?? "";
  const orderMatch = s.match(/order\s*#?([A-Za-z0-9-]+)/i);
  const escrowMatch = s.match(/escrow\s*#?([A-Za-z0-9-]+)/i);
  const disputeMatch = s.match(/dispute\s*#?([A-Za-z0-9-]+)/i);
  if (tab === "orders" && orderMatch) {
    return { kind: "order", ref: shortRef("O", orderMatch[1]), meta: s.split("·").pop()?.trim() || "Order", tab };
  }
  if (tab === "escrow") {
    const ref = escrowMatch ? shortRef("E", escrowMatch[1]) : disputeMatch ? shortRef("D", disputeMatch[1]) : "Escrow";
    const meta = disputeMatch ? `Dispute ${shortRef("D", disputeMatch[1])}` : s.split("·").pop()?.trim() || "Escrow";
    return { kind: "escrow", ref, meta, tab };
  }
  if (tab === "quotes") {
    return { kind: "quote", ref: "Quote", meta: s.split("·").pop()?.trim() || s, tab };
  }
  return null;
}

export async function attachFromQuote(quoteId: string): Promise<InboxAttach | null> {
  const q = await prisma.rfqQuote.findUnique({
    where: { id: quoteId },
    include: { rfq: { select: { id: true, qty: true, title: true } } },
  });
  if (!q) return null;
  const sym = q.currency === "NGN" ? "₦" : q.currency === "USD" ? "$" : "¥";
  const total = Number(q.amountMinor);
  const qty = Math.max(1, Number(String(q.rfq?.qty ?? "1").replace(/\D/g, "")) || 1);
  const unit = total / 100 / qty;
  const leadMatch = q.note?.match(/(\d+)\s*d/i);
  return {
    kind: "quote",
    ref: shortRef("Q", q.id),
    meta: `${sym}${unit.toLocaleString(undefined, { maximumFractionDigits: 0 })}/unit · ${leadMatch ? `${leadMatch[1]}d` : "21d"}`,
    tab: "quotes",
  };
}

export async function attachForConversation(input: {
  latestQuoteId?: string | null;
  subject?: string | null;
  productId?: string | null;
}): Promise<InboxAttach | null> {
  if (input.latestQuoteId) {
    const fromQuote = await attachFromQuote(input.latestQuoteId);
    if (fromQuote) return fromQuote;
  }
  const fromSubject = attachFromSubject(input.subject);
  if (fromSubject) return fromSubject;
  if (input.productId) {
    const product = await prisma.product.findUnique({
      where: { id: input.productId },
      select: { id: true, title: true, moq: true },
    });
    if (product) {
      return {
        kind: "quote",
        ref: shortRef("Q", product.id),
        meta: product.moq ? `MOQ ${product.moq}` : product.title.slice(0, 24),
        tab: "quotes",
      };
    }
  }
  return null;
}

export function formatInboxTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((startOfToday.getTime() - startOfMsg.getTime()) / 86400000);
  if (dayDiff === 0) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  if (dayDiff === 1) return "Yest";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
