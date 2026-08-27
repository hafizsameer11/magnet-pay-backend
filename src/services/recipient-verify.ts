import { prisma } from "../lib/prisma.js";
import { getNombaProvider, type BeneficiaryVerifyInput } from "./nomba.js";

export async function verifyRecipientById(recipientId: string, userId: string) {
  const row = await prisma.recipient.findFirst({
    where: { id: recipientId, userId },
  });
  if (!row) return null;

  const nomba = getNombaProvider();
  const input: BeneficiaryVerifyInput = {
    userId,
    rail: row.rail,
    accountHint: row.accountHint,
    beneficiaryName: row.name,
    currency: row.currency,
  };

  const result = await nomba.verifyBeneficiary(input);

  return prisma.recipient.update({
    where: { id: row.id },
    data: {
      verificationStatus: result.status,
      verifiedAccountName: result.accountName ?? null,
      verificationMessage: result.message ?? null,
      verifiedAt: result.status === "VERIFIED" ? new Date() : null,
    },
  });
}

export function assertRecipientVerified(status: string) {
  if (status === "VERIFIED") return;
  if (status === "MISMATCH") {
    throw new Error("Recipient name does not match the account on file");
  }
  if (status === "FAILED") {
    throw new Error("Recipient could not be verified — check account details");
  }
  throw new Error("Recipient verification is still pending — try again shortly");
}
