/**
 * One-shot prep for demo testing — sync FX, relax tier gates, ensure fee config.
 * Run on server: npx tsx scripts/demo-prep.ts
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  ensureDefaultFxFeeConfig,
  syncFeeConfigRatesToFxTable,
} from "../src/services/fx-rates-sync.js";

const prisma = new PrismaClient();

async function main() {
  await ensureDefaultFxFeeConfig();
  const synced = await syncFeeConfigRatesToFxTable();
  await prisma.complianceLimits.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      unverifiedNgnDailyCapMinor: 0,
      ngnTier1DailyCapMinor: 500_000_00,
      ngnTier2DailyCapMinor: 20_000_000_00,
      cnyDailyCapMinor: 200_000_00,
      minTierDeposit: 1,
      minTierWithdraw: 1,
      minTierCrossBorder: 1,
      minTierMarketCheckout: 1,
      minTierLogistics: 1,
      allowBasicWhilePending: true,
    },
    update: {
      minTierCrossBorder: 1,
      minTierMarketCheckout: 1,
      minTierLogistics: 1,
      allowBasicWhilePending: true,
    },
  });
  console.log(`Demo prep complete — synced ${synced} FX pairs to mobile rate table.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
