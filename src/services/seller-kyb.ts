import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { fail } from "../lib/http.js";

export class KybRequiredError extends Error {
  constructor(message = "Business verification must be approved before selling") {
    super(message);
    this.name = "KybRequiredError";
  }
}

export async function assertSellerKybApproved(userId: string) {
  const profile = await prisma.businessProfile.findUnique({
    where: { userId },
    select: { status: true },
  });
  if (!profile || profile.status !== "APPROVED") {
    throw new KybRequiredError(
      profile?.status === "SUBMITTED"
        ? "Your business documents are under review. You can sell once admin approves KYB."
        : "Complete business verification (KYB) and wait for admin approval before selling.",
    );
  }
}

export function requireSellerKyb(req: Request, res: Response, next: NextFunction) {
  void assertSellerKybApproved(req.user!.id)
    .then(() => next())
    .catch((e) => {
      if (e instanceof KybRequiredError) return fail(res, 403, "KYB_REQUIRED", e.message);
      next(e);
    });
}
