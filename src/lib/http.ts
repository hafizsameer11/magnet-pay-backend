import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "./prisma.js";

export type AuthUser = {
  id: string;
  role: string;
  platformRole: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signAccess(user: AuthUser): string {
  return jwt.sign(user, env("JWT_SECRET"), { expiresIn: "7d" });
}

export function signRefresh(user: AuthUser): string {
  return jwt.sign({ ...user, typ: "refresh" }, env("JWT_REFRESH_SECRET"), { expiresIn: "30d" });
}

export function verifyAccess(token: string): AuthUser {
  return jwt.verify(token, env("JWT_SECRET")) as AuthUser;
}

export function verifyRefresh(token: string): AuthUser & { typ?: string } {
  return jwt.verify(token, env("JWT_REFRESH_SECRET")) as AuthUser & { typ?: string };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing token" } });
  }
  try {
    req.user = verifyAccess(header.slice(7));
    next();
  } catch {
    return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid token" } });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if (!req.user || (req.user.platformRole !== "ADMIN" && req.user.platformRole !== "SUPER_ADMIN")) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Admin only" } });
    }
    next();
  });
}

export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ data });
}

export function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

/** Serialize BigInt for JSON */
export function serialize<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}
