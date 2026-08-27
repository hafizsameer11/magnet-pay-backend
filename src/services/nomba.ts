import { prisma } from "../lib/prisma.js";
import { env } from "../lib/prisma.js";

export type ChinaPayoutInput = {
  userId: string;
  amountMinor: bigint;
  currency: "CNY" | "NGN" | "USD";
  rail: "BANK" | "WECHAT" | "ALIPAY";
  accountHint: string;
  beneficiaryName: string;
  note?: string;
};

export type BeneficiaryVerifyInput = {
  userId: string;
  rail: "BANK" | "WECHAT" | "ALIPAY";
  accountHint: string;
  beneficiaryName: string;
  currency: "CNY" | "NGN" | "USD";
};

export type BeneficiaryVerifyResult = {
  status: "VERIFIED" | "MISMATCH" | "FAILED";
  accountName?: string;
  message?: string;
  providerRef?: string;
};

export type ChinaPayoutResult = {
  providerRef: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
  raw: unknown;
};

export type TransferStatus = {
  providerRef: string;
  status: "SUCCESS" | "FAILED" | "PENDING";
};

export interface NombaProvider {
  sendToChina(input: ChinaPayoutInput): Promise<ChinaPayoutResult>;
  verifyBeneficiary(input: BeneficiaryVerifyInput): Promise<BeneficiaryVerifyResult>;
  getTransferStatus(providerRef: string): Promise<TransferStatus>;
}

class MockNombaProvider implements NombaProvider {
  async verifyBeneficiary(input: BeneficiaryVerifyInput): Promise<BeneficiaryVerifyResult> {
    const hint = input.accountHint.replace(/\s/g, "");
    const providerRef = `nomba_verify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let result: BeneficiaryVerifyResult;
    if (hint.length < 4) {
      result = {
        status: "FAILED",
        message: "Invalid account identifier",
        providerRef,
      };
    } else if (/mismatch/i.test(input.beneficiaryName)) {
      result = {
        status: "MISMATCH",
        accountName: "陈伟 (Chen Wei)",
        message: "Account name differs from the name you entered",
        providerRef,
      };
    } else {
      result = {
        status: "VERIFIED",
        accountName: input.beneficiaryName.trim(),
        message: "Name matched with payout provider",
        providerRef,
      };
    }

    await prisma.providerEvent.create({
      data: {
        userId: input.userId,
        provider: "nomba",
        kind: "verifyBeneficiary",
        payload: { mock: true, input, result, at: new Date().toISOString() },
      },
    });
    return result;
  }

  async sendToChina(input: ChinaPayoutInput): Promise<ChinaPayoutResult> {
    if (input.amountMinor <= 0n) throw new Error("Invalid amount");
    const providerRef = `nomba_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const raw = {
      mock: true,
      providerRef,
      amountMinor: input.amountMinor.toString(),
      currency: input.currency,
      rail: input.rail,
      accountHint: input.accountHint,
      beneficiaryName: input.beneficiaryName,
      note: input.note,
      at: new Date().toISOString(),
    };
    await prisma.providerEvent.create({
      data: {
        userId: input.userId,
        provider: "nomba",
        kind: "sendToChina",
        payload: raw,
      },
    });
    return { providerRef, status: "SUCCESS", raw };
  }

  async getTransferStatus(providerRef: string): Promise<TransferStatus> {
    return { providerRef, status: "SUCCESS" };
  }
}

class NombaHttpProvider implements NombaProvider {
  async verifyBeneficiary(): Promise<BeneficiaryVerifyResult> {
    throw new Error("Nomba live verify not configured — set NOMBA_MODE=mock or add API keys");
  }
  async sendToChina(): Promise<ChinaPayoutResult> {
    throw new Error("Nomba live mode not configured — set NOMBA_MODE=mock or add API keys");
  }
  async getTransferStatus(): Promise<TransferStatus> {
    throw new Error("Nomba live mode not configured");
  }
}

export function getNombaProvider(): NombaProvider {
  return env("NOMBA_MODE", "mock") === "live" ? new NombaHttpProvider() : new MockNombaProvider();
}
