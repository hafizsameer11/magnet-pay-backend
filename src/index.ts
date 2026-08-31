import { createApp } from "./app.js";
import { env } from "./lib/prisma.js";
import {
  ensureDefaultFxFeeConfig,
  syncFeeConfigRatesToFxTable,
} from "./services/fx-rates-sync.js";
import { ensureLegalPagesSeed } from "./services/legal-content.js";

const port = Number(env("PORT", "4000"));
const host = env("HOST", "0.0.0.0");

async function bootstrapFxRates() {
  await ensureDefaultFxFeeConfig();
  const synced = await syncFeeConfigRatesToFxTable();
  if (synced > 0) {
    console.log(`FX bootstrap: synced ${synced} rate pairs to mobile table`);
  }
}

async function bootstrapLegalContent() {
  await ensureLegalPagesSeed();
}

async function main() {
  try {
    await bootstrapFxRates();
    await bootstrapLegalContent();
  } catch (err) {
    console.error("FX bootstrap failed (API will still start):", err);
  }

  const app = createApp();
  app.listen(port, host, () => {
    console.log(`MagnetPay API listening on http://${host}:${port}`);
  });
}

main();
