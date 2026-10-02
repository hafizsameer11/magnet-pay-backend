export type NameCheckKind = "phone" | "meter" | "smartcard" | "account" | "wallet" | "bvn" | string;

export type NameCheckResult =
  | { ok: true; name: string }
  | { ok: false; name?: string; message: string };

/**
 * Stub name enquiry — returns a plausible name when the value has a valid length.
 * Replace with NIBSS / biller APIs in production.
 */
export function stubNameCheck(kind: NameCheckKind, value: string): NameCheckResult {
  const v = String(value ?? "").trim();
  if (!v) {
    return { ok: false, message: "Value required" };
  }

  const digits = v.replace(/\D/g, "");

  switch (kind) {
    case "phone":
      if (digits.length < 10 || digits.length > 14) {
        return { ok: false, message: "Enter a valid phone number" };
      }
      return { ok: true, name: maskName("Adaeze Okonkwo") };
    case "meter":
      if (digits.length < 8 || digits.length > 13) {
        return { ok: false, message: "Enter a valid meter number" };
      }
      return { ok: true, name: "IKEJA ELECTRIC · PREPAID" };
    case "smartcard":
      if (digits.length < 8 || digits.length > 14) {
        return { ok: false, message: "Enter a valid smartcard / IUC number" };
      }
      return { ok: true, name: "CHUKWUMA EMEKA" };
    case "account":
      if (digits.length !== 10) {
        return { ok: false, message: "Account number must be 10 digits" };
      }
      return { ok: true, name: "IKEJA UNION VENTURES" };
    case "wallet":
      if (v.length < 3) {
        return { ok: false, message: "Enter a valid wallet ID, tag, or phone" };
      }
      return { ok: true, name: "Emeka Nwosu" };
    case "bvn":
      if (digits.length !== 11) {
        return { ok: false, message: "BVN must be 11 digits" };
      }
      return { ok: true, name: "IKEJA UNION" };
    default:
      if (v.length < 4) {
        return { ok: false, message: "Value too short" };
      }
      return { ok: true, name: "Verified Customer" };
  }
}

function maskName(name: string) {
  return name;
}
