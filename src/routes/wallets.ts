import { Router } from "express";
import { z } from "zod";
import type { Currency } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {fail, ok, requireAuth, serialize, param } from "../lib/http.js";
import {
  creditWallet,
  debitWallet,
  formatMoney,
  recordTx,
} from "../services/ledger.js";
import { getNombaProvider } from "../services/nomba.js";
import { deliverUserNotification } from "../services/deliver.js";
import { assertWithinDailyLimit, getWalletLimits } from "../services/limits.js";
import { assertKycForAction, KycRequiredError } from "../services/kyc-access.js";

export const walletsRouter = Router();

walletsRouter.get("/limits", requireAuth, async (req, res) => {
  const limits = await getWalletLimits(req.user!.id);
  return ok(res, serialize(limits));
});

walletsRouter.get("/", requireAuth, async (req, res) => {
  const wallets = await prisma.wallet.findMany({ where: { userId: req.user!.id } });
  const mapped = wallets.map((w) => ({
    ...w,
    balanceMinor: w.balanceMinor.toString(),
    holdMinor: w.holdMinor.toString(),
    availableMinor: (w.balanceMinor - w.holdMinor).toString(),
    display: formatMoney(w.currency, w.balanceMinor - w.holdMinor),
  }));
  const usd = wallets.find((w) => w.currency === "USD");
  const totalUsdMinor = usd?.balanceMinor ?? 0n;
  return ok(res, {
    wallets: mapped,
    totalUsdDisplay: formatMoney("USD", totalUsdMinor),
  });
});

walletsRouter.get("/transactions", requireAuth, async (req, res) => {
  const rows = await prisma.transaction.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return ok(res, serialize(rows));
});

walletsRouter.get("/statement", requireAuth, async (req, res) => {
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86400000);
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const rows = await prisma.transaction.findMany({
    where: { userId: req.user!.id, createdAt: { gte: from, lte: to } },
    orderBy: { createdAt: "desc" },
  });
  const lines = [
    "Date,Title,Subtitle,Amount,Status",
    ...rows.map(
      (t) =>
        `${t.createdAt.toISOString()},${JSON.stringify(t.title)},${JSON.stringify(t.subtitle ?? "")},${JSON.stringify(t.amountDisplay)},${t.status ?? ""}`,
    ),
  ];
  return ok(res, { csv: lines.join("\n"), count: rows.length, from: from.toISOString(), to: to.toISOString() });
});

walletsRouter.get("/transactions/:id", requireAuth, async (req, res) => {
  const row = await prisma.transaction.findFirst({
    where: { id: param(req, "id"), userId: req.user!.id },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Transaction not found");
  return ok(res, serialize(row));
});

walletsRouter.get("/virtual-account", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return fail(res, 404, "NOT_FOUND", "User not found");
  // Deterministic mock Nomba VA per user (demo); number derived from user id digits
  const digits = user.id.replace(/\D/g, "").padEnd(10, "0").slice(0, 10);
  return ok(res, {
    bank: "Wema Bank (Providus)",
    number: `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`,
    name: `MPay/${user.name}`,
    currency: "NGN",
    provider: "nomba_mock",
  });
});

walletsRouter.post("/deposit", requireAuth, async (req, res) => {
  const body = z
    .object({
      currency: z.enum(["NGN", "CNY", "USD"]),
      amountMinor: z.union([z.string(), z.number()]),
      method: z.string().default("virtual_account"),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid deposit");
  const amountMinor = BigInt(body.data.amountMinor);
  if (amountMinor <= 0n) return fail(res, 400, "VALIDATION", "Amount must be positive");

  try {
    await assertKycForAction(req.user!.id, "deposit");
    await assertWithinDailyLimit(req.user!.id, "deposit", body.data.currency, amountMinor);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    const result = await prisma.$transaction(async (tx) => {
      const deposit = await tx.deposit.create({
        data: {
          userId: req.user!.id,
          currency: body.data.currency,
          amountMinor,
          method: body.data.method,
          status: "SUCCEEDED",
        },
      });
      await creditWallet(
        tx,
        req.user!.id,
        body.data.currency,
        amountMinor,
        `Deposit ${body.data.currency}`,
        deposit.id,
      );
      const transaction = await recordTx(tx, {
        userId: req.user!.id,
        kind: "deposit",
        title: "Wallet funded",
        subtitle: `${body.data.method} · ${body.data.currency}`,
        currency: body.data.currency,
        amountDisplay: `+${formatMoney(body.data.currency, amountMinor)}`,
        amountPositive: true,
        status: "SUCCEEDED",
        icon: "arrow-down-left",
      });
      return { deposit, transaction };
    });
    const digits = (user?.id ?? "").replace(/\D/g, "").padEnd(10, "0").slice(0, 10);
    return ok(
      res,
      serialize({
        ...result.deposit,
        transactionId: result.transaction.id,
        virtualAccount: {
          bank: "Wema Bank (Providus)",
          number: `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`,
          name: `MPay/${user?.name ?? "Customer"}`,
        },
      }),
      201,
    );
  } catch (e) {
    if (e instanceof KycRequiredError) return fail(res, 403, "KYC_REQUIRED", e.message);
    return fail(res, 400, "DEPOSIT_FAILED", e instanceof Error ? e.message : "Deposit failed");
  }
});

walletsRouter.post("/withdraw", requireAuth, async (req, res) => {
  const body = z
    .object({
      currency: z.enum(["NGN", "CNY", "USD"]),
      amountMinor: z.union([z.string(), z.number()]),
      rail: z.enum(["BANK", "WECHAT", "ALIPAY"]).default("BANK"),
      destination: z.string().min(3),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid withdraw");
  const amountMinor = BigInt(body.data.amountMinor);
  if (amountMinor <= 0n) return fail(res, 400, "VALIDATION", "Amount must be positive");

  try {
    await assertKycForAction(req.user!.id, "withdraw");
    await assertWithinDailyLimit(req.user!.id, "withdraw", body.data.currency, amountMinor);
    const result = await prisma.$transaction(async (tx) => {
      await debitWallet(
        tx,
        req.user!.id,
        body.data.currency,
        amountMinor,
        `Withdraw ${body.data.currency}`,
        undefined,
        body.data.currency === "CNY" ? "NOMBA_PAYABLE" : "SYSTEM_CLEARING",
      );
      let providerRef: string | undefined;
      if (body.data.currency === "CNY") {
        const nomba = getNombaProvider();
        const payout = await nomba.sendToChina({
          userId: req.user!.id,
          amountMinor,
          currency: "CNY",
          rail: body.data.rail,
          accountHint: body.data.destination,
          beneficiaryName: "Self",
        });
        providerRef = payout.providerRef;
      }
      const w = await tx.withdrawal.create({
        data: {
          userId: req.user!.id,
          currency: body.data.currency,
          amountMinor,
          rail: body.data.rail,
          destination: body.data.destination,
          status: "SUCCEEDED",
          providerRef,
        },
      });
      await recordTx(tx, {
        userId: req.user!.id,
        kind: "withdraw",
        title: "Withdrawal",
        subtitle: body.data.destination,
        currency: body.data.currency,
        amountDisplay: `−${formatMoney(body.data.currency, amountMinor)}`,
        amountPositive: false,
        status: "SUCCEEDED",
        icon: "arrow-up-right",
      });
      return w;
    });
    return ok(res, serialize(result), 201);
  } catch (e) {
    if (e instanceof KycRequiredError) return fail(res, 403, "KYC_REQUIRED", e.message);
    return fail(res, 400, "WITHDRAW_FAILED", e instanceof Error ? e.message : "Withdraw failed");
  }
});

walletsRouter.post("/fx/quote", requireAuth, async (req, res) => {
  const body = z
    .object({
      from: z.enum(["NGN", "CNY", "USD"]),
      to: z.enum(["NGN", "CNY", "USD"]),
      amountMinor: z.union([z.string(), z.number()]),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid quote");
  if (body.data.from === body.data.to) return fail(res, 400, "VALIDATION", "Same currency");
  const pair = `${body.data.from}_${body.data.to}`;
  const reverse = `${body.data.to}_${body.data.from}`;
  let rateRow = await prisma.fxRate.findUnique({ where: { pair } });
  let rate = rateRow ? Number(rateRow.rate) : null;
  let spreadBps = rateRow?.spreadBps ?? 50;
  if (rate == null) {
    const rev = await prisma.fxRate.findUnique({ where: { pair: reverse } });
    if (!rev) return fail(res, 404, "NO_RATE", "FX rate not found");
    rate = 1 / Number(rev.rate);
    spreadBps = rev.spreadBps;
  }
  const amount = Number(body.data.amountMinor);
  const mid = amount * rate;
  const out = Math.floor(mid * (1 - spreadBps / 10000));
  return ok(res, {
    from: body.data.from,
    to: body.data.to,
    fromMinor: String(body.data.amountMinor),
    toMinor: String(out),
    rate,
    spreadBps,
  });
});

walletsRouter.post("/fx/convert", requireAuth, async (req, res) => {
  const body = z
    .object({
      from: z.enum(["NGN", "CNY", "USD"]),
      to: z.enum(["NGN", "CNY", "USD"]),
      amountMinor: z.union([z.string(), z.number()]),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid convert");
  const fromMinor = BigInt(body.data.amountMinor);
  const quoteRes = await (async () => {
    const pair = `${body.data.from}_${body.data.to}`;
    const reverse = `${body.data.to}_${body.data.from}`;
    let rateRow = await prisma.fxRate.findUnique({ where: { pair } });
    let rate = rateRow ? Number(rateRow.rate) : null;
    let spreadBps = rateRow?.spreadBps ?? 50;
    if (rate == null) {
      const rev = await prisma.fxRate.findUnique({ where: { pair: reverse } });
      if (!rev) throw new Error("NO_RATE");
      rate = 1 / Number(rev.rate);
      spreadBps = rev.spreadBps;
    }
    const out = BigInt(Math.floor(Number(fromMinor) * rate * (1 - spreadBps / 10000)));
    return { rate, toMinor: out };
  })().catch(() => null);
  if (!quoteRes) return fail(res, 404, "NO_RATE", "FX rate not found");

  try {
    await assertKycForAction(req.user!.id, "fx_convert");
    const conversion = await prisma.$transaction(async (tx) => {
      await debitWallet(tx, req.user!.id, body.data.from as Currency, fromMinor, `FX sell ${body.data.from}`);
      await creditWallet(tx, req.user!.id, body.data.to as Currency, quoteRes.toMinor, `FX buy ${body.data.to}`);
      const row = await tx.fxConversion.create({
        data: {
          userId: req.user!.id,
          fromCurrency: body.data.from,
          toCurrency: body.data.to,
          fromMinor,
          toMinor: quoteRes.toMinor,
          rateApplied: quoteRes.rate,
        },
      });
      await recordTx(tx, {
        userId: req.user!.id,
        kind: "fx",
        title: `${body.data.from} → ${body.data.to}`,
        subtitle: "Converted out",
        currency: body.data.from as Currency,
        amountDisplay: `−${formatMoney(body.data.from as Currency, fromMinor)}`,
        amountPositive: false,
        icon: "repeat",
      });
      await recordTx(tx, {
        userId: req.user!.id,
        kind: "fx",
        title: `${body.data.from} → ${body.data.to}`,
        subtitle: "Converted in",
        currency: body.data.to as Currency,
        amountDisplay: `+${formatMoney(body.data.to as Currency, quoteRes.toMinor)}`,
        amountPositive: true,
        icon: "repeat",
      });
      return row;
    });
    return ok(res, serialize(conversion), 201);
  } catch (e) {
    if (e instanceof KycRequiredError) return fail(res, 403, "KYC_REQUIRED", e.message);
    return fail(res, 400, "FX_FAILED", e instanceof Error ? e.message : "Convert failed");
  }
});

walletsRouter.post("/p2p", requireAuth, async (req, res) => {
  const body = z
    .object({
      phone: z.string().min(8),
      currency: z.enum(["NGN", "CNY", "USD"]),
      amountMinor: z.union([z.string(), z.number()]),
      note: z.string().max(200).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid P2P transfer");
  const amountMinor = BigInt(body.data.amountMinor);
  if (amountMinor <= 0n) return fail(res, 400, "VALIDATION", "Amount must be positive");

  const phone = body.data.phone.replace(/\s+/g, "");
  const recipient = await prisma.user.findFirst({ where: { phone } });
  if (!recipient) return fail(res, 404, "NOT_FOUND", "No MagnetPay user with that phone");
  if (recipient.id === req.user!.id) {
    return fail(res, 400, "SELF_TRANSFER", "Cannot send to yourself");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      let wallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId: recipient.id, currency: body.data.currency } },
      });
      if (!wallet) {
        wallet = await tx.wallet.create({
          data: { userId: recipient.id, currency: body.data.currency, balanceMinor: 0n },
        });
      }

      await debitWallet(
        tx,
        req.user!.id,
        body.data.currency,
        amountMinor,
        `P2P to ${recipient.name || phone}`,
      );
      await creditWallet(
        tx,
        recipient.id,
        body.data.currency,
        amountMinor,
        `P2P from ${req.user!.id.slice(0, 8)}`,
      );

      const note = body.data.note?.trim() || undefined;
      const display = formatMoney(body.data.currency, amountMinor);
      await recordTx(tx, {
        userId: req.user!.id,
        kind: "p2p",
        title: `Sent to ${recipient.name || phone}`,
        subtitle: note ?? phone,
        currency: body.data.currency,
        amountDisplay: `−${display}`,
        amountPositive: false,
        status: "SUCCEEDED",
        icon: "send",
      });
      await recordTx(tx, {
        userId: recipient.id,
        kind: "p2p",
        title: `Received from MagnetPay user`,
        subtitle: note ?? phone,
        currency: body.data.currency,
        amountDisplay: `+${display}`,
        amountPositive: true,
        status: "SUCCEEDED",
        icon: "arrow-down-left",
      });
      return {
        amountMinor: amountMinor.toString(),
        currency: body.data.currency,
        note: note ?? null,
        display,
        recipient: { id: recipient.id, name: recipient.name, phone: recipient.phone },
      };
    });
    void deliverUserNotification(result.recipient.id, {
      title: "Money received",
      body: `${result.display}${result.note ? ` · ${result.note}` : ""}`,
      href: "/notifications",
      email: {
        prefKey: "emailTransfers",
        subject: "Money received on MagnetPay",
        text: `Hi ${result.recipient.name || "there"},\n\nYou received ${result.display}${result.note ? ` (${result.note})` : ""} via P2P.\n\n— MagnetPay`,
      },
    });
    return ok(res, serialize({ ...result, recipient: result.recipient }), 201);
  } catch (e) {
    return fail(res, 400, "P2P_FAILED", e instanceof Error ? e.message : "Transfer failed");
  }
});
