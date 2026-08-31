import { prisma } from "../lib/prisma.js";
import { verifyBvn, verifyNin } from "./prembly.js";
import { mpEmail, notifyUser } from "./user-notify.js";

function payloadRecord(raw: unknown) {
  return (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
}

export async function processKycVerification(applicationId: string) {
  const app = await prisma.kycApplication.findUnique({
    where: { id: applicationId },
    include: { user: { select: { id: true, name: true, email: true, dateOfBirth: true } } },
  });
  if (!app || app.status !== "SUBMITTED") return;

  const payload = payloadRecord(app.payload);
  if (payload.premblyStatus === "verified" || payload.premblyStatus === "failed") return;

  const number = String(payload.number ?? "").replace(/\D/g, "");
  if (!number) {
    await rejectKyc(app.id, app.userId, app.user.name, payload, "Missing identity number");
    return;
  }

  await prisma.kycApplication.update({
    where: { id: app.id },
    data: {
      payload: {
        ...payload,
        premblyStatus: "processing",
        premblyStartedAt: new Date().toISOString(),
      },
    },
  });

  const profileName = app.user.name?.trim() || "User";
  const profileDob = app.user.dateOfBirth
    ? app.user.dateOfBirth.toISOString().slice(0, 10)
    : null;
  const profile = { name: profileName, dateOfBirth: profileDob };
  const result =
    app.type === "BVN" ? await verifyBvn(number, profile) : await verifyNin(number, profile);

  if (result.ok) {
    await prisma.kycApplication.update({
      where: { id: app.id },
      data: {
        status: "APPROVED",
        tier: Math.max(1, app.tier),
        payload: {
          ...payload,
          number,
          premblyStatus: "verified",
          premblyVerifiedAt: new Date().toISOString(),
          premblyResponseCode: result.responseCode,
          premblyMessage: result.message,
        },
      },
    });
    notifyUser(app.userId, {
      title: "Identity verified",
      body: `Your ${app.type} check passed. You're cleared to continue on MagnetPay.`,
      href: "/kyc-status",
      emailPref: "emailKyc",
      emailSubject: "MagnetPay — identity verified",
      emailText: mpEmail(app.user.name, [
        `Your ${app.type} verification was successful.`,
        "You can continue using MagnetPay without waiting for manual review.",
      ]),
    });
    return;
  }

  await rejectKyc(
    app.id,
    app.userId,
    app.user.name,
    payload,
    result.message || "Identity verification failed",
    result.responseCode,
  );
}

async function rejectKyc(
  id: string,
  userId: string,
  userName: string | null,
  payload: Record<string, unknown>,
  reason: string,
  code?: string,
) {
  await prisma.kycApplication.update({
    where: { id },
    data: {
      status: "REJECTED",
      payload: {
        ...payload,
        premblyStatus: "failed",
        premblyRejectedAt: new Date().toISOString(),
        premblyResponseCode: code ?? "FAILED",
        rejectionReason: reason,
      },
    },
  });
  notifyUser(userId, {
    title: "Verification failed",
    body: reason,
    href: "/kyc1",
    emailPref: "emailKyc",
    emailSubject: "MagnetPay — verification failed",
    emailText: mpEmail(userName, [
      "We could not verify your identity details.",
      reason,
      "Please re-check your name and number, then submit again.",
    ]),
  });
}

/** Fire-and-forget async Prembly check after user submits KYC. */
export function scheduleKycVerification(applicationId: string) {
  setImmediate(() => {
    void processKycVerification(applicationId).catch((err) => {
      console.error("[kyc-verify]", applicationId, err);
    });
  });
}
