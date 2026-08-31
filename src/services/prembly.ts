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

export type VerifyProfile = {
  name: string;
  dateOfBirth?: string | null;
};

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function premblyMode() {
  return process.env.PREMBLY_MODE?.trim() || process.env.NOMBA_MODE?.trim() || "mock";
}

function apiKey() {
  return process.env.PREMBLY_API_KEY?.trim() ?? "";
}

function pickStr(obj: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return undefined;
}

function normalizeDob(raw: string): string | null {
  const trimmed = raw.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmy) {
    const d = dmy[1].padStart(2, "0");
    const m = dmy[2].padStart(2, "0");
    return `${dmy[3]}-${m}-${d}`;
  }

  const dmyText = trimmed.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/i);
  if (dmyText) {
    const month = MONTHS[dmyText[2].slice(0, 3).toLowerCase()];
    if (!month) return null;
    const d = dmyText[1].padStart(2, "0");
    const m = String(month).padStart(2, "0");
    return `${dmyText[3]}-${m}-${d}`;
  }

  return null;
}

function dobsMatch(profileDob: string, recordDob: string) {
  const left = normalizeDob(profileDob);
  const right = normalizeDob(recordDob);
  return !!left && !!right && left === right;
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

function extractIdentityData(json: Record<string, unknown>) {
  const data = (json.data && typeof json.data === "object" ? json.data : {}) as Record<string, unknown>;
  const ninData = (json.nin_data && typeof json.nin_data === "object" ? json.nin_data : {}) as Record<string, unknown>;
  const merged = { ...ninData, ...data };

  return {
    firstName: pickStr(merged, "firstName", "firstname", "first_name"),
    middleName: pickStr(merged, "middleName", "middlename", "middle_name"),
    lastName: pickStr(merged, "lastName", "surname", "last_name"),
    dateOfBirth: pickStr(merged, "dateOfBirth", "birthdate", "date_of_birth", "dob"),
  };
}

function validateAgainstProfile(
  result: PremblyVerifyResult,
  profile: VerifyProfile,
  idLabel: "BVN" | "NIN",
): PremblyVerifyResult {
  if (!result.ok) return result;

  if (!namesMatch(profile.name, result.firstName, result.middleName, result.lastName)) {
    return {
      ...result,
      ok: false,
      responseCode: "NAME_MISMATCH",
      message: `Name on your profile does not match ${idLabel} records`,
    };
  }

  if (profile.dateOfBirth) {
    if (!result.dateOfBirth) {
      return {
        ...result,
        ok: false,
        responseCode: "DOB_MISSING",
        message: `${idLabel} records did not include a date of birth to verify against`,
      };
    }
    if (!dobsMatch(profile.dateOfBirth, result.dateOfBirth)) {
      return {
        ...result,
        ok: false,
        responseCode: "DOB_MISMATCH",
        message: `Date of birth on your profile does not match ${idLabel} records`,
      };
    }
  }

  return result;
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
    return { ok: false, responseCode: "NO_KEY", message: "Prembly secret key not configured" };
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "x-api-key": key,
  };

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const identity = extractIdentityData(json);
  const responseCode = String(json.response_code ?? "");
  const ok = json.status === true && responseCode === "00";

  return {
    ok,
    responseCode: responseCode || (ok ? "00" : "FAILED"),
    message: String(json.message ?? json.detail ?? "Verification failed"),
    firstName: identity.firstName,
    middleName: identity.middleName,
    lastName: identity.lastName,
    dateOfBirth: identity.dateOfBirth,
    raw: json,
  };
}

export async function verifyNin(nin: string, profile: VerifyProfile): Promise<PremblyVerifyResult> {
  const number = nin.replace(/\D/g, "");
  if (number.length !== 11) {
    return { ok: false, responseCode: "LOCAL", message: "NIN must be 11 digits" };
  }
  if (premblyMode() === "mock" && !apiKey()) {
    const mock: PremblyVerifyResult = {
      ok: true,
      responseCode: "00",
      message: "Mock NIN verification successful",
      firstName: profile.name.split(/\s+/)[0],
      lastName: profile.name.split(/\s+/).slice(-1)[0],
      dateOfBirth: profile.dateOfBirth ?? undefined,
    };
    return validateAgainstProfile(mock, profile, "NIN");
  }

  const result = await postPrembly("/verification/vnin", { number_nin: number });
  return validateAgainstProfile(result, profile, "NIN");
}

export async function verifyBvn(bvn: string, profile: VerifyProfile): Promise<PremblyVerifyResult> {
  const number = bvn.replace(/\D/g, "");
  if (number.length !== 11) {
    return { ok: false, responseCode: "LOCAL", message: "BVN must be 11 digits" };
  }
  if (premblyMode() === "mock" && !apiKey()) {
    const mock: PremblyVerifyResult = {
      ok: true,
      responseCode: "00",
      message: "Mock BVN verification successful",
      firstName: profile.name.split(/\s+/)[0],
      lastName: profile.name.split(/\s+/).slice(-1)[0],
      dateOfBirth: profile.dateOfBirth ?? undefined,
    };
    return validateAgainstProfile(mock, profile, "BVN");
  }

  const result = await postPrembly("/verification/bvn", { number });
  return validateAgainstProfile(result, profile, "BVN");
}
