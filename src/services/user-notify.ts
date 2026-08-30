import { prisma } from "../lib/prisma.js";
import { deliverUserNotification } from "./deliver.js";
import type { EmailPrefKey } from "./notify.js";

export type UserNotifyInput = {
  title: string;
  body: string;
  href?: string;
  emailPref?: EmailPrefKey;
  emailSubject?: string;
  /** Plain-text email body (full message). */
  emailText?: string;
  push?: boolean;
};

export function mpEmail(name: string | null | undefined, lines: string[]) {
  return `Hi ${name || "there"},\n\n${lines.join("\n")}\n\n— MagnetPay`;
}

/** In-app + push + optional email (respects user prefs). */
export function notifyUser(userId: string | null | undefined, input: UserNotifyInput) {
  if (!userId) return;
  void deliverUserNotification(userId, {
    title: input.title,
    body: input.body,
    href: input.href,
    push: input.push,
    email:
      input.emailPref && input.emailSubject && input.emailText
        ? { prefKey: input.emailPref, subject: input.emailSubject, text: input.emailText }
        : undefined,
  });
}

export function notifyUsers(userIds: Array<string | null | undefined>, input: UserNotifyInput) {
  for (const id of [...new Set(userIds.filter(Boolean))] as string[]) {
    notifyUser(id, input);
  }
}

export async function notifyConversationPeers(
  conversationId: string,
  senderId: string,
  input: UserNotifyInput,
) {
  const peers = await prisma.conversationParticipant.findMany({
    where: { conversationId, userId: { not: senderId } },
    select: { userId: true },
  });
  notifyUsers(
    peers.map((p) => p.userId),
    input,
  );
}

/** Notify seller store owner by store id or name slug. */
export async function notifySellerBySupplier(
  supplier: string,
  input: UserNotifyInput,
) {
  const store = await prisma.sellerStore.findFirst({
    where: { OR: [{ id: supplier }, { name: supplier }] },
    select: { userId: true },
  });
  notifyUser(store?.userId, input);
}
