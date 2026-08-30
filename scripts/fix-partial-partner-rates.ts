import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function tableExists(table: string) {
  const rows = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    table,
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function fkExists(table: string, constraint: string) {
  const rows = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    table,
    constraint,
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function main() {
  if (await tableExists("LogisticsPartnerRate")) {
    await prisma.$executeRawUnsafe(`DROP TABLE \`LogisticsPartnerRate\``);
    console.log("Dropped partial LogisticsPartnerRate table.");
  }

  if (await fkExists("ShippingQuote", "ShippingQuote_partnerId_fkey")) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`ShippingQuote\` DROP FOREIGN KEY \`ShippingQuote_partnerId_fkey\``,
    );
    console.log("Dropped ShippingQuote partner FK (will re-add on migrate).");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
