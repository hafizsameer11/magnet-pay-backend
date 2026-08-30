import type { Currency, Transaction } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { formatMoney } from "./ledger.js";

export type ReceiptTimelineStep = { title: string; time: string; done: boolean };
export type ReceiptDetailRow = { label: string; value: string; mono?: boolean; copy?: boolean };

export type TransactionReceipt = {
  headline: string;
  receiptType: string;
  directionLabel: string;
  counterparty: string;
  amount: string;
  kind: string;
  currency: Currency;
  direction: "in" | "out" | "convert";
  state: "completed" | "processing" | "failed";
  timeline: ReceiptTimelineStep[];
  details: ReceiptDetailRow[];
  footerNote: string;
};

function txState(status: string | null | undefined): "completed" | "processing" | "failed" {
  const st = (status ?? "").toUpperCase();
  if (st.includes("FAIL")) return "failed";
  if (st.includes("PEND") || st.includes("PROCESS")) return "processing";
  if (st.includes("SUCCESS") || st.includes("COMPLETE") || st.includes("SUCCEEDED")) return "completed";
  return "completed";
}

function headlineFor(state: "completed" | "processing" | "failed") {
  if (state === "failed") return "Failed";
  if (state === "processing") return "Processing";
  return "Confirmed";
}

function fmtTime(d: Date) {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `Today · ${time}` : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function shortRef(id: string) {
  return `MP-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function maskAccount(h: string) {
  const s = h.replace(/\s+/g, "");
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}••${s.slice(-4)}`;
}

function railLabel(rail: string) {
  if (rail === "WECHAT") return "WeChat";
  if (rail === "ALIPAY") return "Alipay";
  return "Bank";
}

function receiptType(kind: string) {
  const map: Record<string, string> = {
    transfer: "Transfer receipt",
    deposit: "Deposit receipt",
    withdraw: "Withdrawal receipt",
    fx: "Conversion receipt",
    p2p: "P2P transfer receipt",
    escrow: "Escrow receipt",
    escrow_release: "Escrow release receipt",
    order: "Order receipt",
    refund: "Refund receipt",
    logistics_hold: "Logistics hold receipt",
    logistics_topup: "Logistics payment receipt",
    logistics_cashback: "Cashback receipt",
    admin_adjustment: "Wallet adjustment",
  };
  return map[kind] ?? "Transaction receipt";
}

function directionFor(tx: Transaction): "in" | "out" | "convert" {
  if (tx.kind === "fx" || tx.icon === "repeat") return "convert";
  if (tx.amountPositive === true) return "in";
  return "out";
}

function directionLabel(tx: Transaction, direction: "in" | "out" | "convert") {
  const ccy = tx.currency;
  if (direction === "in") return `${ccy} · Received from`;
  if (direction === "convert") return `${ccy} · Converted`;
  return `${ccy} · Paid to`;
}

function counterpartyFromTitle(title: string) {
  return title
    .replace(/^Sent to\s+/i, "")
    .replace(/^Received from\s+/i, "")
    .trim();
}

function offsetTime(base: Date, minutes: number) {
  return new Date(base.getTime() + minutes * 60_000);
}

function defaultTimeline(
  tx: Transaction,
  state: "completed" | "processing" | "failed",
  steps: { title: string; offsetMin: number }[],
): ReceiptTimelineStep[] {
  return steps.map((s, i) => {
    const isLast = i === steps.length - 1;
    const done =
      state === "completed" ? true : state === "failed" ? !isLast : i < steps.length - 1;
    const title =
      state === "failed" && isLast
        ? steps[steps.length - 1].title.replace(/credited|completed|settled/i, "failed")
        : s.title;
    return { title, time: fmtTime(offsetTime(tx.createdAt, s.offsetMin)), done };
  });
}

async function findRelatedTransfer(tx: Transaction) {
  if (tx.kind !== "transfer") return null;
  const t0 = tx.createdAt.getTime();
  return prisma.transfer.findFirst({
    where: {
      senderId: tx.userId,
      createdAt: { gte: new Date(t0 - 120_000), lte: new Date(t0 + 120_000) },
    },
    include: { recipient: true, events: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
}

async function findRelatedFx(tx: Transaction) {
  if (tx.kind !== "fx") return null;
  const t0 = tx.createdAt.getTime();
  return prisma.fxConversion.findFirst({
    where: {
      userId: tx.userId,
      createdAt: { gte: new Date(t0 - 120_000), lte: new Date(t0 + 120_000) },
    },
    orderBy: { createdAt: "desc" },
  });
}

async function findRelatedWithdrawal(tx: Transaction) {
  if (tx.kind !== "withdraw") return null;
  const t0 = tx.createdAt.getTime();
  return prisma.withdrawal.findFirst({
    where: {
      userId: tx.userId,
      createdAt: { gte: new Date(t0 - 120_000), lte: new Date(t0 + 120_000) },
    },
    orderBy: { createdAt: "desc" },
  });
}

async function findRelatedDeposit(tx: Transaction) {
  if (tx.kind !== "deposit") return null;
  const t0 = tx.createdAt.getTime();
  return prisma.deposit.findFirst({
    where: {
      userId: tx.userId,
      createdAt: { gte: new Date(t0 - 120_000), lte: new Date(t0 + 120_000) },
    },
    orderBy: { createdAt: "desc" },
  });
}

async function fxRateLine(from: Currency, to: Currency) {
  const pair = `${from}_${to}`;
  const row = await prisma.fxRate.findUnique({ where: { pair } });
  if (row) {
    const n = Number(row.rate);
    const sym = to === "NGN" ? "₦" : to === "CNY" ? "¥" : "$";
    return `1 ${from} = ${sym}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  const rev = await prisma.fxRate.findUnique({ where: { pair: `${to}_${from}` } });
  if (rev) {
    const n = 1 / Number(rev.rate);
    const sym = to === "NGN" ? "₦" : to === "CNY" ? "¥" : "$";
    return `1 ${from} = ${sym}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return null;
}

function pushDetail(rows: ReceiptDetailRow[], label: string, value?: string | null, opts?: { mono?: boolean; copy?: boolean }) {
  if (!value?.trim()) return;
  rows.push({ label, value: value.trim(), mono: opts?.mono, copy: opts?.copy });
}

export async function buildTransactionReceipt(tx: Transaction): Promise<TransactionReceipt> {
  const state = txState(tx.status);
  const direction = directionFor(tx);
  const counterparty = counterpartyFromTitle(tx.title);
  const ref = shortRef(tx.id);
  const details: ReceiptDetailRow[] = [];

  pushDetail(details, "Reference", ref, { mono: true, copy: true });
  pushDetail(details, "Status", headlineFor(state));

  let timeline: ReceiptTimelineStep[] = [];
  let footerNote = "This document is a system-generated receipt and is valid without signature.";

  if (tx.kind === "transfer") {
    const transfer = await findRelatedTransfer(tx);
    const recipient = transfer?.recipient;
    pushDetail(details, direction === "in" ? "Sender" : "Recipient", recipient?.name ?? counterparty);
    if (recipient) {
      pushDetail(details, "Channel", `${railLabel(recipient.rail)} · ${maskAccount(recipient.accountHint)}`);
    } else if (tx.subtitle) {
      pushDetail(details, "Channel", tx.subtitle);
    }
    pushDetail(details, "Purpose", transfer?.note || tx.subtitle || "GDS · Goods trade");
    if (tx.currency === "CNY" || recipient?.currency === "CNY") {
      const fx = await fxRateLine("CNY", "NGN");
      if (fx) pushDetail(details, "FX rate", fx, { mono: true });
    }
    if (transfer?.nombaRef) pushDetail(details, "Provider ref", transfer.nombaRef, { mono: true });
    pushDetail(details, "Amount", tx.amountDisplay, { mono: true });
    pushDetail(details, "Direction", "Sent");
    pushDetail(details, "Settled", fmtTime(tx.createdAt));

    if (transfer?.events?.length) {
      timeline = transfer.events.map((e) => ({
        title: e.message.replace(/^Delivered\s*/i, "Recipient credited").replace(/\([^)]*\)/, "").trim() || e.status,
        time: fmtTime(e.createdAt),
        done: state !== "failed" && e.status !== "FAILED",
      }));
    } else {
      timeline = defaultTimeline(tx, state, [
        { title: "Authorized", offsetMin: 0 },
        { title: "FX settled", offsetMin: 1 },
        { title: "Payout sent", offsetMin: 3 },
        { title: "Recipient credited", offsetMin: 4 },
      ]);
    }
    footerNote = "Settled via licensed FX partner. Receipt available as PDF.";
  } else if (tx.kind === "deposit") {
    const deposit = await findRelatedDeposit(tx);
    pushDetail(details, "Method", deposit?.method?.replace(/_/g, " ") ?? tx.subtitle);
    pushDetail(details, "Amount", tx.amountDisplay, { mono: true });
    pushDetail(details, "Direction", "Received");
    pushDetail(details, "Wallet", `${tx.currency} wallet`);
    pushDetail(details, "Settled", fmtTime(tx.createdAt));
    timeline = defaultTimeline(tx, state, [
      { title: "Payment received", offsetMin: 0 },
      { title: "Wallet credited", offsetMin: 1 },
    ]);
  } else if (tx.kind === "withdraw") {
    const withdrawal = await findRelatedWithdrawal(tx);
    pushDetail(details, "Destination", withdrawal?.destination ?? tx.subtitle);
    pushDetail(details, "Rail", withdrawal ? railLabel(withdrawal.rail) : "Bank");
    pushDetail(details, "Amount", tx.amountDisplay, { mono: true });
    pushDetail(details, "Direction", "Sent");
    pushDetail(details, "Settled", fmtTime(tx.createdAt));
    if (withdrawal?.providerRef) pushDetail(details, "Provider ref", withdrawal.providerRef, { mono: true });
    timeline = defaultTimeline(tx, state, [
      { title: "Withdrawal requested", offsetMin: 0 },
      { title: "Sent to bank", offsetMin: 2 },
      { title: "Completed", offsetMin: 5 },
    ]);
  } else if (tx.kind === "fx") {
    const fx = await findRelatedFx(tx);
    if (fx) {
      pushDetail(details, "From", formatMoney(fx.fromCurrency, fx.fromMinor), { mono: true });
      pushDetail(details, "To", formatMoney(fx.toCurrency, fx.toMinor), { mono: true });
      pushDetail(
        details,
        "FX rate",
        `1 ${fx.fromCurrency} = ${Number(fx.rateApplied).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} ${fx.toCurrency}`,
        { mono: true },
      );
    }
    pushDetail(details, "Amount", tx.amountDisplay, { mono: true });
    pushDetail(details, "Leg", tx.subtitle || (tx.amountPositive ? "Converted in" : "Converted out"));
    pushDetail(details, "Settled", fmtTime(tx.createdAt));
    timeline = defaultTimeline(tx, state, [
      { title: "Quote locked", offsetMin: 0 },
      { title: "FX converted", offsetMin: 1 },
      { title: tx.amountPositive ? "Wallet credited" : "Debited", offsetMin: 2 },
    ]);
    footerNote = "Settled via licensed FX partner. Rate includes spread.";
  } else if (tx.kind === "p2p") {
    pushDetail(details, direction === "in" ? "Sender" : "Recipient", counterparty);
    pushDetail(details, "Note", tx.subtitle);
    pushDetail(details, "Amount", tx.amountDisplay, { mono: true });
    pushDetail(details, "Direction", direction === "in" ? "Received" : "Sent");
    pushDetail(details, "Settled", fmtTime(tx.createdAt));
    timeline = defaultTimeline(tx, state, [
      { title: "Authorized", offsetMin: 0 },
      { title: direction === "in" ? "Received" : "Sent", offsetMin: 1 },
      { title: direction === "in" ? "Available" : "Recipient credited", offsetMin: 2 },
    ]);
  } else if (tx.kind === "escrow" || tx.kind === "escrow_release") {
    pushDetail(details, "Deal", counterparty);
    pushDetail(details, "Detail", tx.subtitle);
    pushDetail(details, "Amount", tx.amountDisplay, { mono: true });
    pushDetail(details, "Direction", tx.amountPositive ? "Released" : "Funded");
    pushDetail(details, "Settled", fmtTime(tx.createdAt));
    timeline = defaultTimeline(tx, state, [
      { title: tx.kind === "escrow_release" ? "Milestone approved" : "Escrow funded", offsetMin: 0 },
      { title: tx.kind === "escrow_release" ? "Released to seller" : "Held in trust", offsetMin: 2 },
      { title: "Completed", offsetMin: 4 },
    ]);
    footerNote = "Funds held by MagnetPay Trust until milestone release.";
  } else if (tx.kind === "order") {
    pushDetail(details, "Order", counterparty);
    pushDetail(details, "Detail", tx.subtitle);
    pushDetail(details, "Amount", tx.amountDisplay, { mono: true });
    pushDetail(details, "Direction", tx.amountPositive ? "Received" : "Paid");
    pushDetail(details, "Settled", fmtTime(tx.createdAt));
    timeline = defaultTimeline(tx, state, [
      { title: "Order placed", offsetMin: 0 },
      { title: "Payment captured", offsetMin: 1 },
      { title: "Escrow held", offsetMin: 3 },
    ]);
  } else if (tx.kind === "refund") {
    pushDetail(details, "Original transfer", tx.subtitle);
    pushDetail(details, "Amount", tx.amountDisplay, { mono: true });
    pushDetail(details, "Direction", "Received");
    pushDetail(details, "Settled", fmtTime(tx.createdAt));
    timeline = defaultTimeline(tx, state, [
      { title: "Refund initiated", offsetMin: 0 },
      { title: "Wallet credited", offsetMin: 2 },
    ]);
  } else if (tx.kind.startsWith("logistics")) {
    pushDetail(details, "Shipment", counterparty);
    pushDetail(details, "Detail", tx.subtitle);
    pushDetail(details, "Amount", tx.amountDisplay, { mono: true });
    pushDetail(details, "Type", receiptType(tx.kind));
    pushDetail(details, "Settled", fmtTime(tx.createdAt));
    timeline = defaultTimeline(tx, state, [
      { title: "Booking confirmed", offsetMin: 0 },
      { title: "Hold placed", offsetMin: 2 },
      { title: "Completed", offsetMin: 5 },
    ]);
  } else {
    pushDetail(details, direction === "in" ? "Sender" : "Recipient", counterparty);
    pushDetail(details, "Detail", tx.subtitle);
    pushDetail(details, "Amount", tx.amountDisplay, { mono: true });
    pushDetail(
      details,
      "Direction",
      direction === "in" ? "Received" : direction === "convert" ? "Conversion" : "Sent",
    );
    pushDetail(details, "Settled", fmtTime(tx.createdAt));
    timeline = defaultTimeline(tx, state, [
      { title: "Recorded", offsetMin: 0 },
      { title: state === "failed" ? "Failed" : "Settled", offsetMin: 2 },
    ]);
  }

  return {
    headline: headlineFor(state),
    receiptType: receiptType(tx.kind),
    directionLabel: directionLabel(tx, direction),
    counterparty,
    amount: tx.amountDisplay,
    kind: tx.kind,
    currency: tx.currency,
    direction,
    state,
    timeline,
    details,
    footerNote,
  };
}
