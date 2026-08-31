import { Router } from "express";
import { fail, ok, serialize, param } from "../lib/http.js";
import { getLegalOperator, getPublishedLegalPage, listPublishedLegalPages } from "../services/legal-content.js";

export const contentRouter = Router();

contentRouter.get("/legal", async (_req, res) => {
  const [operator, pages] = await Promise.all([getLegalOperator(), listPublishedLegalPages()]);
  return ok(res, serialize({ operator, pages }));
});

contentRouter.get("/legal/:slug", async (req, res) => {
  const page = await getPublishedLegalPage(String(param(req, "slug")));
  if (!page) return fail(res, 404, "NOT_FOUND", "Legal document not found");
  return ok(res, serialize(page));
});
