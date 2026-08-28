import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { fail, ok, requireAuth, serialize } from "../lib/http.js";
import { creditWallet, debitWallet, formatMoney, recordTx } from "../services/ledger.js";
import { getNombaProvider } from "../services/nomba.js";
import { assertRecipientVerified, verifyRecipientById } from "../services/recipient-verify.js";
import { deliverUserNotification } from "../services/deliver.js";
import { assertWithinDailyLimit } from "../services/limits.js";
import { assertKycForAction, KycRequiredError } from "../services/kyc-access.js";

export const recipientsRouter = Router();
export const transfersRouter = Router();

recipientsRouter.get("/", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  let rows = await prisma.recipient.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  const pending = rows.filter((r) => r.verificationStatus === "PENDING");
  if (pending.length > 0) {
    await Promise.all(pending.map((r) => verifyRecipientById(r.id, userId)));
    rows = await prisma.recipient.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }
  return ok(res, serialize(rows));
});

recipientsRouter.post("/", requireAuth, async (req, res) => {
  const body = z
    .object({
      name: z.string().min(2),
      subtitle: z.string().optional(),
      rail: z.enum(["BANK", "WECHAT", "ALIPAY"]).default("BANK"),
      currency: z.enum(["NGN", "CNY", "USD"]).default("CNY"),
      accountHint: z.string().min(2),
      country: z.string().default("CN"),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid recipient");
  const row = await prisma.recipient.create({
    data: { userId: req.user!.id, ...body.data },
  });
  const verified = await verifyRecipientById(row.id, req.user!.id);
  return ok(res, serialize(verified ?? row), 201);
});

recipientsRouter.post("/:id/verify", requireAuth, async (req, res) => {
  const updated = await verifyRecipientById(req.params.id, req.user!.id);
  if (!updated) return fail(res, 404, "NOT_FOUND", "Recipient not found");
  return ok(res, serialize(updated));
});

recipientsRouter.get("/:id", requireAuth, async (req, res) => {
  const row = await prisma.recipient.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Recipient not found");
  return ok(res, serialize(row));
});

recipientsRouter.delete("/:id", requireAuth, async (req, res) => {
  const row = await prisma.recipient.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Recipient not found");
  await prisma.recipient.delete({ where: { id: row.id } });
  return ok(res, { ok: true });
});

transfersRouter.get("/", requireAuth, async (req, res) => {
  const rows = await prisma.transfer.findMany({
    where: { senderId: req.user!.id },
    include: { recipient: true, events: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  return ok(res, serialize(rows));
});

transfersRouter.get("/:id", requireAuth, async (req, res) => {
  const row = await prisma.transfer.findFirst({
    where: { id: req.params.id, senderId: req.user!.id },
    include: { recipient: true, events: { orderBy: { createdAt: "asc" } } },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Transfer not found");
  return ok(res, serialize(row));
});

transfersRouter.post("/", requireAuth, async (req, res) => {
  const body = z
    .object({
      recipientId: z.string().uuid(),
      amountMinor: z.union([z.string(), z.number()]),
      currency: z.enum(["NGN", "CNY", "USD"]).default("CNY"),
      note: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid transfer");
  const amountMinor = BigInt(body.data.amountMinor);
  if (amountMinor <= 0n) return fail(res, 400, "VALIDATION", "Amount must be positive");

  const recipient = await prisma.recipient.findFirst({
    where: { id: body.data.recipientId, userId: req.user!.id },
  });
  if (!recipient) return fail(res, 404, "NOT_FOUND", "Recipient not found");

  try {
    assertRecipientVerified(recipient.verificationStatus);
  } catch (e) {
    return fail(res, 400, "NOT_VERIFIED", e instanceof Error ? e.message : "Recipient not verified");
  }

  // Fees match mobile review: 0.8% FX margin + network fee (¥18 bank / ¥6 wallet rails), in fen.
  const networkFeeMinor = recipient.rail === "BANK" ? 1800n : 600n;
  const fxFeeMinor = (amountMinor * 80n) / 10000n;
  const totalDebitMinor = amountMinor + fxFeeMinor + networkFeeMinor;

  try {
    if (body.data.currency === "CNY") {
      await assertKycForAction(req.user!.id, "send");
    }
    await assertWithinDailyLimit(req.user!.id, "send", body.data.currency, amountMinor);
    const transfer = await prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId: req.user!.id, currency: body.data.currency } },
      });
      const available = wallet ? wallet.balanceMinor - wallet.holdMinor : 0n;
      if (!wallet || available < totalDebitMinor) {
        throw new Error(
          `Insufficient ${body.data.currency} balance · available ${formatMoney(body.data.currency, available)} · need ${formatMoney(body.data.currency, totalDebitMinor)} (incl. fees)`,
        );
      }

      const t = await tx.transfer.create({
        data: {
          senderId: req.user!.id,
          recipientId: recipient.id,
          currency: body.data.currency,
          amountMinor,
          note: body.data.note,
          status: "PROCESSING",
        },
      });
      await tx.transferEvent.create({
        data: { transferId: t.id, status: "CREATED", message: "Transfer created" },
      });
      await tx.transferEvent.create({
        data: { transferId: t.id, status: "PROCESSING", message: "Sending via Nomba" },
      });

      await debitWallet(
        tx,
        req.user!.id,
        body.data.currency,
        totalDebitMinor,
        `Send to ${recipient.name}`,
        t.id,
        "NOMBA_PAYABLE",
      );

      const nomba = getNombaProvider();
      const payout = await nomba.sendToChina({
        userId: req.user!.id,
        amountMinor,
        currency: body.data.currency,
        rail: recipient.rail,
        accountHint: recipient.accountHint,
        beneficiaryName: recipient.name,
        note: body.data.note,
      });

      const updated = await tx.transfer.update({
        where: { id: t.id },
        data: { status: "SUCCEEDED", nombaRef: payout.providerRef },
        include: { recipient: true, events: true },
      });
      await tx.transferEvent.create({
        data: {
          transferId: t.id,
          status: "SUCCEEDED",
          message: `Delivered (${payout.providerRef})`,
        },
      });
      await recordTx(tx, {
        userId: req.user!.id,
        kind: "transfer",
        title: recipient.name,
        subtitle: "Outbound payment",
        currency: body.data.currency,
        amountDisplay: `−${formatMoney(body.data.currency, totalDebitMinor)}`,
        amountPositive: false,
        status: "SUCCEEDED",
        icon: "arrow-up-right",
      });
      return updated;
    });
    const sender = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, email: true, name: true, notificationPrefs: true, deviceTokens: true },
    });
    void deliverUserNotification(req.user!.id, {
      title: "Transfer succeeded",
      body: `${formatMoney(body.data.currency, amountMinor)} to ${recipient.name}`,
      href: `/tx/${transfer.id}`,
      email: {
        prefKey: "emailTransfers",
        subject: "Transfer succeeded",
        text: `Hi ${sender?.name || "there"},\n\nYour transfer of ${formatMoney(body.data.currency, amountMinor)} to ${recipient.name} succeeded.\n\n— MagnetPay`,
      },
    });
    return ok(res, serialize(transfer), 201);
  } catch (e) {
    if (e instanceof KycRequiredError) return fail(res, 403, "KYC_REQUIRED", e.message);
    return fail(res, 400, "TRANSFER_FAILED", e instanceof Error ? e.message : "Transfer failed");
  }
});

transfersRouter.post("/:id/retry", requireAuth, async (req, res) => {
  const row = await prisma.transfer.findFirst({
    where: { id: req.params.id, senderId: req.user!.id },
    include: { recipient: true },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Transfer not found");
  if (row.status !== "FAILED") return fail(res, 400, "BAD_STATE", "Only failed transfers can be retried");
  const nomba = getNombaProvider();
  try {
    const payout = await nomba.sendToChina({
      userId: req.user!.id,
      amountMinor: row.amountMinor,
      currency: row.currency,
      rail: row.recipient!.rail,
      accountHint: row.recipient!.accountHint,
      beneficiaryName: row.recipient!.name,
      note: row.note ?? undefined,
    });
    const updated = await prisma.$transaction(async (tx) => {
      await tx.transferEvent.create({
        data: { transferId: row.id, status: "PROCESSING", message: "Retry initiated" },
      });
      return tx.transfer.update({
        where: { id: row.id },
        data: { status: "SUCCEEDED", nombaRef: payout.providerRef },
        include: { recipient: true, events: { orderBy: { createdAt: "asc" } } },
      });
    });
    const sender = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { email: true, name: true, notificationPrefs: true },
    });
    notifyUserEmail(
      sender,
      "emailTransfers",
      "Transfer succeeded",
      `Hi ${sender?.name || "there"},\n\nYour transfer of ${formatMoney(row.currency, row.amountMinor)} to ${row.recipient?.name ?? "recipient"} succeeded (retry).\n\n— MagnetPay`,
    );
    return ok(res, serialize(updated));
  } catch (e) {
    return fail(res, 400, "RETRY_FAILED", e instanceof Error ? e.message : "Retry failed");
  }
});

transfersRouter.post("/:id/refund", requireAuth, async (req, res) => {
  const row = await prisma.transfer.findFirst({
    where: { id: req.params.id, senderId: req.user!.id },
  });
  if (!row) return fail(res, 404, "NOT_FOUND", "Transfer not found");
  if (!["FAILED", "PROCESSING", "REFUNDED"].includes(row.status)) {
    return fail(res, 400, "BAD_STATE", "Transfer cannot be refunded");
  }
  if (row.status === "REFUNDED") {
    return fail(res, 400, "ALREADY_REFUNDED", "Transfer already refunded");
  }
  try {
    const updated = await prisma.$transaction(async (tx) => {
      await creditWallet(tx, req.user!.id, row.currency, row.amountMinor, `Refund transfer ${row.id.slice(0, 8)}`, row.id);
      await tx.transferEvent.create({
        data: { transferId: row.id, status: "REFUNDED", message: "Refunded to wallet" },
      });
      await recordTx(tx, {
        userId: req.user!.id,
        kind: "refund",
        title: "Transfer refunded",
        subtitle: row.id.slice(0, 8),
        currency: row.currency,
        amountDisplay: `+${formatMoney(row.currency, row.amountMinor)}`,
        amountPositive: true,
        status: "SUCCEEDED",
        icon: "arrow-down-left",
      });
      return tx.transfer.update({
        where: { id: row.id },
        data: { status: "REFUNDED" },
        include: { recipient: true, events: { orderBy: { createdAt: "asc" } } },
      });
    });
    return ok(res, serialize(updated));
  } catch (e) {
    return fail(res, 400, "REFUND_FAILED", e instanceof Error ? e.message : "Refund failed");
  }
});
