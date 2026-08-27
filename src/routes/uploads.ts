import { Router } from "express";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fail, ok, requireAuth } from "../lib/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.resolve(__dirname, "../../uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const uploadsRouter = Router();

uploadsRouter.post("/", requireAuth, async (req, res) => {
  const body = z
    .object({
      filename: z.string().min(1),
      contentBase64: z.string().min(8),
      mimeType: z.string().default("application/octet-stream"),
    })
    .safeParse(req.body);
  if (!body.success) return fail(res, 400, "VALIDATION", "Invalid upload");
  const ext = path.extname(body.data.filename) || (body.data.mimeType.includes("pdf") ? ".pdf" : ".jpg");
  const name = `${randomBytes(12).toString("hex")}${ext}`;
  const raw = body.data.contentBase64.replace(/^data:[^;]+;base64,/, "");
  const buf = Buffer.from(raw, "base64");
  if (buf.length > 8 * 1024 * 1024) return fail(res, 400, "TOO_LARGE", "Max 8MB per file");
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return ok(res, { url: `/files/${name}`, name: body.data.filename, mimeType: body.data.mimeType }, 201);
});
