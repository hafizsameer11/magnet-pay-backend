import Expo, { type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { prisma } from "../lib/prisma.js";
import { mergeNotificationPrefs, parseDeviceTokens } from "./notify.js";

const expo = new Expo();

type PushUser = {
  id?: string;
  notificationPrefs?: unknown;
  deviceTokens?: unknown;
};

/** Send push via Expo Push Service (uses FCM/APNs credentials stored on Expo). */
export async function notifyUserPush(
  user: PushUser | null | undefined,
  title: string,
  body: string,
  data?: Record<string, unknown>,
) {
  if (!user?.id) return;
  const prefs = mergeNotificationPrefs(user.notificationPrefs);
  if (!prefs.pushEnabled) return;

  const tokens = parseDeviceTokens(user.deviceTokens).filter((t) => Expo.isExpoPushToken(t));
  if (!tokens.length) return;

  const messages: ExpoPushMessage[] = tokens.map((to) => ({
    to,
    sound: "default",
    title,
    body,
    data: data ?? {},
  }));

  const invalid: string[] = [];
  try {
    for (const chunk of expo.chunkPushNotifications(messages)) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket: ExpoPushTicket, i) => {
        if (ticket.status === "error") {
          const err = ticket.details?.error;
          if (err === "DeviceNotRegistered" && chunk[i]?.to) {
            invalid.push(String(chunk[i].to));
          }
          console.warn("[push] ticket error", err, chunk[i]?.to);
        }
      });
    }
  } catch (e) {
    console.error("[push] send failed", e);
    return;
  }

  if (invalid.length) {
    const remaining = tokens.filter((t) => !invalid.includes(t));
    await prisma.user.update({
      where: { id: user.id },
      data: { deviceTokens: remaining as object },
    });
  }
}
