import "dotenv/config";
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v == null) throw new Error(`Missing env ${key}`);
  return v;
}
