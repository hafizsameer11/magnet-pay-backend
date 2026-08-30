const BASE = "https://api.prembly.com";

export type PremblyVerifyResult = {
  ok: boolean;
  responseCode: string;
  message: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  dateOfBirth?: string;
  raw?: unknown;
};

function premblyMode() {
  return process.env.PREMBLY_MODE?.trim() || process.env.NOMBA_MODE?.trim() || "mock";
}

function apiKey() {
  return process.env.PREMBLY_API_KEY?.trim() ?? "";
}

function namesMatch(profileName: string, first?: string, middle?: string, last?: string) {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const profileParts = new Set(norm(profileName));
  if (!profileParts.size) return true;
  const idParts = norm([first, middle, last].filter(Boolean).join(" "));
  if (!idParts.length) return true;
  const hits = idParts.filter((p) => profileParts.has(p)).length;
  return hits >= Math.min(2, idParts.length) || hits >= 1;
}

async function postPrembly(path: string, body: Record<string, string>): Promise<PremblyVerifyResult> {
  const key = apiKey();
  if (!key) {
    if (premblyMode() === "mock") {
      return {
        ok: true,
        responseCode: "00",
        message: "Mock verification successful",
        firstName: "Mock",
        lastName: "User",
      };
    }
    return { ok: false, responseCode: "NO_KEY", message: "Prembly API key not configured" };
  }

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": key,
      ...(process.env.PREMBLY_APP_ID?.trim() ? { "app-id": process.env.PREMBLY_APP_ID.trim() } : {}),
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const data = (json.data ?? json.nin_data ?? {}) as Record<string, unknown>;
  const responseCode = String(json.response_code ?? "");
  const ok = json.status === true && responseCode === "00";

  return {
    ok,
    responseCode,
    message: String(json.message ?? json.detail ?? "Verification failed"),
    firstName: data.firstname ? String(data.firstname) : undefined,
    middleName: data.middlename ? String(data.middlename) : undefined,
    lastName: data.surname ? String(data.surname) : undefined,
    dateOfBirth: data.birthdate ? String(data.birthdate) : undefined,
    raw: json,
  };
}

export async function verifyNin(nin: string, profileName: string): Promise<PremblyVerifyResult> {
  const number = nin.replace(/\D/g, "");
  if (number.length !== 11) {
    return { ok: false, responseCode: "LOCAL", message: "NIN must be 11 digits" };
  }
  if (premblyMode() === "mock" && !apiKey()) {
    return {
      ok: true,
      responseCode: "00",
      message: "Mock NIN verification successful",
      firstName: profileName.split(/\s+/)[0],
      lastName: profileName.split(/\s+/).slice(-1)[0],
    };
  }
  const result = await postPrembly("/verification/vnin", { number_nin: number });
  if (!result.ok) return result;
  if (!namesMatch(profileName, result.firstName, result.middleName, result.lastName)) {
    return {
      ...result,
      ok: false,
      responseCode: "NAME_MISMATCH",
      message: "Name on your profile does not match NIN records",
    };
  }
  return result;
}

export async function verifyBvn(bvn: string, profileName: string): Promise<PremblyVerifyResult> {
  const number = bvn.replace(/\D/g, "");
  if (number.length !== 11) {
    return { ok: false, responseCode: "LOCAL", message: "BVN must be 11 digits" };
  }
  if (premblyMode() === "mock" && !apiKey()) {
    return {
      ok: true,
      responseCode: "00",
      message: "Mock BVN verification successful",
      firstName: profileName.split(/\s+/)[0],
      lastName: profileName.split(/\s+/).slice(-1)[0],
    };
  }
  const result = await postPrembly("/verification/bvn", { number });
  if (!result.ok) return result;
  if (!namesMatch(profileName, result.firstName, result.middleName, result.lastName)) {
    return {
      ...result,
      ok: false,
      responseCode: "NAME_MISMATCH",
      message: "Name on your profile does not match BVN records",
    };
  }
  return result;
}
