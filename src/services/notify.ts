import { sendEventEmail } from "./email.js";

export type NotificationPrefs = {
  emailTransfers: boolean;
  emailEscrow: boolean;
  emailShipments: boolean;
  emailKyc: boolean;
  pushEnabled: boolean;
};

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  emailTransfers: true,
  emailEscrow: true,
  emailShipments: true,
  emailKyc: true,
  pushEnabled: true,
};

export type EmailPrefKey = "emailTransfers" | "emailEscrow" | "emailShipments" | "emailKyc";

export function mergeNotificationPrefs(raw: unknown): NotificationPrefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    emailTransfers: o.emailTransfers !== false,
    emailEscrow: o.emailEscrow !== false,
    emailShipments: o.emailShipments !== false,
    emailKyc: o.emailKyc !== false,
    pushEnabled: o.pushEnabled !== false,
  };
}

export function parseDeviceTokens(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && t.length > 0);
}

/** Fire-and-forget email if user has an address and the given pref is enabled. */
export function notifyUserEmail(
  user: { email?: string | null; notificationPrefs?: unknown } | null | undefined,
  prefKey: EmailPrefKey,
  subject: string,
  text: string,
) {
  if (!user?.email) return;
  const prefs = mergeNotificationPrefs(user.notificationPrefs);
  if (!prefs[prefKey]) return;
  void sendEventEmail(user.email, subject, text).catch((err) => {
    console.error(`[notify] email failed to=${user.email} subject=${subject}`, err);
  });
}
