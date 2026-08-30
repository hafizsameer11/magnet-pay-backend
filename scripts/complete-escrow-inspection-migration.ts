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

async function indexExists(table: string, index: string) {
  const rows = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    table,
    index,
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function main() {
  for (const col of ["inspectorId", "feeSplit", "autoReleaseHours", "requiredDocs"] as const) {
    if (!(await columnExists("Escrow", col))) {
      const ddl =
        col === "autoReleaseHours"
          ? `ALTER TABLE \`Escrow\` ADD COLUMN \`${col}\` INTEGER NULL`
          : col === "requiredDocs"
            ? `ALTER TABLE \`Escrow\` ADD COLUMN \`${col}\` JSON NULL`
            : `ALTER TABLE \`Escrow\` ADD COLUMN \`${col}\` VARCHAR(191) NULL`;
      await prisma.$executeRawUnsafe(ddl);
      console.log(`Added Escrow.${col}`);
    }
  }

  if (!(await tableExists("Inspector"))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE \`Inspector\` (
        \`id\` VARCHAR(191) NOT NULL,
        \`name\` VARCHAR(191) NOT NULL,
        \`region\` VARCHAR(191) NULL,
        \`feeMinor\` BIGINT NOT NULL DEFAULT 0,
        \`rating\` DOUBLE NOT NULL DEFAULT 0,
        \`active\` BOOLEAN NOT NULL DEFAULT true,
        PRIMARY KEY (\`id\`)
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    console.log("Created Inspector table.");
  }

  if (!(await tableExists("InspectionRequest"))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE \`InspectionRequest\` (
        \`id\` VARCHAR(191) NOT NULL,
        \`escrowId\` VARCHAR(191) NOT NULL,
        \`inspectorId\` VARCHAR(191) NOT NULL,
        \`status\` ENUM('REQUESTED', 'SCHEDULED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'WAIVED') NOT NULL DEFAULT 'REQUESTED',
        \`requiredDocs\` JSON NULL,
        \`reportUrl\` VARCHAR(191) NULL,
        \`failedReason\` VARCHAR(191) NULL,
        \`assignedToId\` VARCHAR(191) NULL,
        \`passedAt\` DATETIME(3) NULL,
        \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updatedAt\` DATETIME(3) NOT NULL,
        INDEX \`InspectionRequest_escrowId_idx\`(\`escrowId\`),
        INDEX \`InspectionRequest_status_idx\`(\`status\`),
        INDEX \`InspectionRequest_inspectorId_idx\`(\`inspectorId\`),
        PRIMARY KEY (\`id\`)
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    console.log("Created InspectionRequest table.");
  }

  if (!(await fkExists("InspectionRequest", "InspectionRequest_escrowId_fkey"))) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE \`InspectionRequest\` ADD CONSTRAINT \`InspectionRequest_escrowId_fkey\`
      FOREIGN KEY (\`escrowId\`) REFERENCES \`Escrow\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
    `);
  }
  if (!(await fkExists("InspectionRequest", "InspectionRequest_inspectorId_fkey"))) {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE \`InspectionRequest\` ADD CONSTRAINT \`InspectionRequest_inspectorId_fkey\`
      FOREIGN KEY (\`inspectorId\`) REFERENCES \`Inspector\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE
    `);
  }

  console.log("escrow_inspection migration state is complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
