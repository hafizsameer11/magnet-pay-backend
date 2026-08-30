import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function columnExists(table: string, column: string) {
  const rows = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    table,
    column,
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

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
  if (!(await tableExists("LogisticsPartnerRate"))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE \`LogisticsPartnerRate\` (
        \`id\` VARCHAR(191) NOT NULL,
        \`partnerId\` VARCHAR(191) NOT NULL,
        \`parcelTypeId\` VARCHAR(191) NULL,
        \`mode\` ENUM('AIR', 'SEA', 'EXPRESS', 'CONSOLIDATED') NOT NULL DEFAULT 'SEA',
        \`baseSurchargeMinor\` INTEGER NOT NULL DEFAULT 0,
        \`rateMultiplierBps\` INTEGER NOT NULL DEFAULT 10000,
        \`etaLabel\` VARCHAR(191) NOT NULL DEFAULT '26–32 days',
        \`badgeLabel\` VARCHAR(191) NULL,
        \`includes\` JSON NOT NULL,
        \`ecoFriendly\` BOOLEAN NOT NULL DEFAULT false,
        \`active\` BOOLEAN NOT NULL DEFAULT true,
        \`sortOrder\` INTEGER NOT NULL DEFAULT 0,
        \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updatedAt\` DATETIME(3) NOT NULL,
        PRIMARY KEY (\`id\`)
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    console.log("Created LogisticsPartnerRate with correct collation.");
  } else {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE \`LogisticsPartnerRate\`
      CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    console.log("Converted LogisticsPartnerRate collation.");
  }

  if (!(await fkExists("LogisticsPartnerRate", "LogisticsPartnerRate_partnerId_fkey"))) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE \`LogisticsPartnerRate\`
      ADD CONSTRAINT \`LogisticsPartnerRate_partnerId_fkey\`
      FOREIGN KEY (\`partnerId\`) REFERENCES \`LogisticsPartner\`(\`id\`)
      ON DELETE CASCADE ON UPDATE CASCADE
    `);
    console.log("Added LogisticsPartnerRate partner FK.");
  }

  if (!(await fkExists("LogisticsPartnerRate", "LogisticsPartnerRate_parcelTypeId_fkey"))) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE \`LogisticsPartnerRate\`
      ADD CONSTRAINT \`LogisticsPartnerRate_parcelTypeId_fkey\`
      FOREIGN KEY (\`parcelTypeId\`) REFERENCES \`ParcelType\`(\`id\`)
      ON DELETE SET NULL ON UPDATE CASCADE
    `);
    console.log("Added LogisticsPartnerRate parcelType FK.");
  }

  if (await columnExists("Category", "defaultParcelTypeId")) {
    await prisma.$executeRawUnsafe(`
      UPDATE \`Category\` SET \`defaultParcelTypeId\` = 'pt-apparel' WHERE \`slug\` IN ('apparel', 'beauty') AND \`defaultParcelTypeId\` IS NULL
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE \`Category\` SET \`defaultParcelTypeId\` = 'pt-electronics' WHERE \`slug\` = 'electronics' AND \`defaultParcelTypeId\` IS NULL
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE \`Category\` SET \`defaultParcelTypeId\` = 'pt-auto_parts' WHERE \`slug\` = 'machinery' AND \`defaultParcelTypeId\` IS NULL
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE \`Category\` SET \`defaultParcelTypeId\` = 'pt-home_furniture' WHERE \`slug\` IN ('home', 'industrial') AND \`defaultParcelTypeId\` IS NULL
    `);
    console.log("Applied category parcel type defaults.");
  }

  console.log("partner_rates migration state is complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
