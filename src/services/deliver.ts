import { prisma } from "../lib/prisma.js";
import type { EmailPrefKey } from "./notify.js";
import { notifyUserEmail } from "./notify.js";
import { notifyUserPush } from "./push.js";

type DeliverInput = {
  title: string;
  body: string;
  href?: string;
  /** Send mobile push (default true). */
  push?: boolean;
  /** Optional transactional email. */
  email?: { prefKey: EmailPrefKey; subject: string; text: string };
};

/** In-app notification row + optional push + optional email. */
export async function deliverUserNotification(userId: string, input: DeliverInput) {
  await prisma.notification.create({
    data: {
      userId,
      title: input.title,
      body: input.body,
      href: input.href ?? null,
    },
  });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      notificationPrefs: true,
      deviceTokens: true,
    },
  });
  if (!user) return;

  if (input.push !== false) {
    void notifyUserPush(user, input.title, input.body, input.href ? { href: input.href } : undefined);
  }

  if (input.email) {
    notifyUserEmail(user, input.email.prefKey, input.email.subject, input.email.text);
  }
}
