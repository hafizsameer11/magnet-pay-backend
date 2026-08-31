import express from "express";
import { env } from "./lib/prisma.js";
import { authRouter } from "./routes/auth.js";
import { meRouter } from "./routes/me.js";
import { walletsRouter } from "./routes/wallets.js";
import { recipientsRouter, transfersRouter } from "./routes/transfers.js";
import { escrowRouter } from "./routes/escrow.js";
import { logisticsRouter } from "./routes/logistics.js";
import { marketRouter } from "./routes/market.js";
import { adminRouter, messagesRouter, notificationsRouter } from "./routes/admin.js";
import { uploadsRouter } from "./routes/uploads.js";
import { contentRouter } from "./routes/content.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.resolve(__dirname, "../uploads");
const SEED_MEDIA_DIR = path.resolve(__dirname, "../seed-media");

export function createApp() {
  const app = express();
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ?? "Content-Type, Authorization",
    );
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: env("JSON_BODY_LIMIT", "12mb") }));

  app.get("/health", (_req, res) => {
    res.json({ data: { ok: true, service: "magnetpay-api", nombaMode: env("NOMBA_MODE", "mock") } });
  });

  app.use("/auth", authRouter);
  app.use("/me", meRouter);
  app.use("/wallets", walletsRouter);
  app.use("/recipients", recipientsRouter);
  app.use("/transfers", transfersRouter);
  app.use("/escrow", escrowRouter);
  app.use("/logistics", logisticsRouter);
  app.use("/market", marketRouter);
  app.use("/notifications", notificationsRouter);
  app.use("/messages", messagesRouter);
  app.use("/admin", adminRouter);
  app.use("/uploads", uploadsRouter);
  app.use("/content", contentRouter);
  app.use("/files", express.static(UPLOAD_DIR));
  app.use("/files/seed", express.static(SEED_MEDIA_DIR));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({
      error: { code: "INTERNAL", message: err instanceof Error ? err.message : "Server error" },
    });
  });

  return app;
}
