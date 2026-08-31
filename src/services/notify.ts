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
  return parseDeviceSessions(raw)
    .map((s) => s.token)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
}

export type DeviceSession = {
  id: string;
  token?: string;
  label: string;
  platform: string;
  lastSeenAt: string;
};

function normalizeDeviceSession(item: unknown): DeviceSession | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : null;
  if (!id) return null;
  const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : "Device";
  const platform = typeof o.platform === "string" && o.platform.trim() ? o.platform.trim() : "unknown";
  const lastSeenAt =
    typeof o.lastSeenAt === "string" && o.lastSeenAt.trim() ? o.lastSeenAt.trim() : new Date().toISOString();
  const token = typeof o.token === "string" && o.token.trim() ? o.token.trim() : undefined;
  return { id, token, label, platform, lastSeenAt };
}

/** Device sessions stored in user.deviceTokens (legacy string[] or session objects). */
export function parseDeviceSessions(raw: unknown): DeviceSession[] {
  if (!Array.isArray(raw)) return [];
  const out: DeviceSession[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.length > 0) {
      out.push({
        id: item.slice(0, 24),
        token: item,
        label: "Device",
        platform: "unknown",
        lastSeenAt: new Date().toISOString(),
      });
      continue;
    }
    const session = normalizeDeviceSession(item);
    if (session) out.push(session);
  }
  return out;
}

export function serializeDeviceSessionsForClient(
  sessions: DeviceSession[],
  currentDeviceId?: string,
): Array<{ id: string; label: string; platform: string; lastSeenAt: string; current: boolean }> {
  return sessions.map((s) => ({
    id: s.id,
    label: s.label,
    platform: s.platform,
    lastSeenAt: s.lastSeenAt,
    current: currentDeviceId ? s.id === currentDeviceId : false,
  }));
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
