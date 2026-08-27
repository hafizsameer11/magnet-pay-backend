/**
 * OTP / transactional email via SMTP (e.g. Hostinger).
 * Without SMTP_HOST configured, codes are logged for local/dev testing.
 * Swap this module for WhatsApp later without changing auth routes.
 */

import nodemailer from "nodemailer";

const FROM = process.env.EMAIL_FROM ?? process.env.SMTP_USER ?? "MagnetPay <noreply@magnetpay.app>";

export function isSmtpConfigured() {
  return Boolean(process.env.SMTP_HOST?.trim() && process.env.SMTP_USER?.trim() && process.env.SMTP_PASS);
}

function smtpTransport() {
  const host = process.env.SMTP_HOST!.trim();
  const port = Number(process.env.SMTP_PORT || 465);
  const secure =
    process.env.SMTP_SECURE != null
      ? process.env.SMTP_SECURE === "true" || process.env.SMTP_SECURE === "1"
      : port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER!.trim(),
      pass: process.env.SMTP_PASS!,
    },
  });
}

export async function sendOtpEmail(to: string, code: string): Promise<{ sent: boolean }> {
  const subject = "Your MagnetPay verification code";
  const text = `Your MagnetPay code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, ignore this email.`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#0f172a">
      <h2 style="margin:0 0 8px;font-size:18px">MagnetPay</h2>
      <p style="margin:0 0 16px;color:#64748b;font-size:14px">Your verification code</p>
      <p style="margin:0;font-size:32px;letter-spacing:8px;font-weight:700">${code}</p>
      <p style="margin:16px 0 0;color:#94a3b8;font-size:12px">Expires in 10 minutes. If you didn't request this, ignore this email.</p>
    </div>
  `;

  if (!isSmtpConfigured()) {
    console.info(`[email-otp] SMTP not configured — to=${to} code=${code}`);
    return { sent: false };
  }

  const transporter = smtpTransport();
  await transporter.sendMail({
    from: FROM,
    to,
    subject,
    text,
    html,
  });
  return { sent: true };
}

/** Generic event / alert email via the same SMTP path as OTP. */
export async function sendEventEmail(
  to: string,
  subject: string,
  text: string,
): Promise<{ sent: boolean }> {
  const safeText = text.trim();
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
      <h2 style="margin:0 0 8px;font-size:18px">MagnetPay</h2>
      <p style="margin:0 0 16px;color:#64748b;font-size:14px">${subject.replace(/</g, "&lt;")}</p>
      <p style="margin:0;font-size:14px;line-height:1.5;white-space:pre-wrap">${safeText.replace(/</g, "&lt;")}</p>
    </div>
  `;

  if (!isSmtpConfigured()) {
    console.info(`[email-event] SMTP not configured — to=${to} subject=${subject}`);
    return { sent: false };
  }

  const transporter = smtpTransport();
  await transporter.sendMail({
    from: FROM,
    to,
    subject,
    text: safeText,
    html,
  });
  return { sent: true };
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
