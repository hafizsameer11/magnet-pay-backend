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

async function indexExists(table: string, index: string) {
  const rows = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    table,
    index,
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

async function tableExists(table: string) {
  const rows = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
    `SELECT COUNT(*) AS cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    table,
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function main() {
  if (!(await tableExists("ProductVariant"))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE \`ProductVariant\` (
        \`id\` VARCHAR(191) NOT NULL,
        \`productId\` VARCHAR(191) NOT NULL,
        \`sku\` VARCHAR(191) NULL,
        \`options\` JSON NOT NULL,
        \`priceMinor\` BIGINT NOT NULL,
        \`stock\` INTEGER NULL,
        \`imageUrl\` VARCHAR(191) NULL,
        \`active\` BOOLEAN NOT NULL DEFAULT true,
        \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        INDEX \`ProductVariant_productId_idx\`(\`productId\`),
        PRIMARY KEY (\`id\`)
      ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    console.log("Created ProductVariant table.");
  }

  if (!(await columnExists("CartItem", "variantId"))) {
    await prisma.$executeRawUnsafe(`ALTER TABLE \`CartItem\` ADD COLUMN \`variantId\` VARCHAR(191) NULL`);
  }
  if (!(await columnExists("CartItem", "variantKey"))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`CartItem\` ADD COLUMN \`variantKey\` VARCHAR(191) NOT NULL DEFAULT ''`,
    );
  }
  if (!(await columnExists("OrderItem", "variantId"))) {
    await prisma.$executeRawUnsafe(`ALTER TABLE \`OrderItem\` ADD COLUMN \`variantId\` VARCHAR(191) NULL`);
  }
  if (!(await columnExists("OrderItem", "variantLabel"))) {
    await prisma.$executeRawUnsafe(`ALTER TABLE \`OrderItem\` ADD COLUMN \`variantLabel\` VARCHAR(191) NULL`);
  }

  if (await indexExists("CartItem", "CartItem_cartId_productId_key")) {
    if (await fkExists("CartItem", "CartItem_cartId_fkey")) {
      await prisma.$executeRawUnsafe(`ALTER TABLE \`CartItem\` DROP FOREIGN KEY \`CartItem_cartId_fkey\``);
    }
    if (await fkExists("CartItem", "CartItem_productId_fkey")) {
      await prisma.$executeRawUnsafe(`ALTER TABLE \`CartItem\` DROP FOREIGN KEY \`CartItem_productId_fkey\``);
    }
    await prisma.$executeRawUnsafe(`DROP INDEX \`CartItem_cartId_productId_key\` ON \`CartItem\``);
    console.log("Dropped legacy CartItem unique index.");
  }

  if (!(await indexExists("CartItem", "CartItem_cartId_productId_variantKey_key"))) {
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX \`CartItem_cartId_productId_variantKey_key\` ON \`CartItem\`(\`cartId\`, \`productId\`, \`variantKey\`)`,
    );
    console.log("Created CartItem variant unique index.");
  }

  if (!(await indexExists("CartItem", "CartItem_productId_idx"))) {
    await prisma.$executeRawUnsafe(`CREATE INDEX \`CartItem_productId_idx\` ON \`CartItem\`(\`productId\`)`);
  }

  if (!(await fkExists("CartItem", "CartItem_cartId_fkey"))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`CartItem\` ADD CONSTRAINT \`CartItem_cartId_fkey\` FOREIGN KEY (\`cartId\`) REFERENCES \`Cart\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }
  if (!(await fkExists("CartItem", "CartItem_productId_fkey"))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`CartItem\` ADD CONSTRAINT \`CartItem_productId_fkey\` FOREIGN KEY (\`productId\`) REFERENCES \`Product\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }
  if (!(await fkExists("ProductVariant", "ProductVariant_productId_fkey"))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`ProductVariant\` ADD CONSTRAINT \`ProductVariant_productId_fkey\` FOREIGN KEY (\`productId\`) REFERENCES \`Product\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }
  if (!(await fkExists("CartItem", "CartItem_variantId_fkey"))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`CartItem\` ADD CONSTRAINT \`CartItem_variantId_fkey\` FOREIGN KEY (\`variantId\`) REFERENCES \`ProductVariant\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE`,
    );
  }
  if (!(await fkExists("OrderItem", "OrderItem_variantId_fkey"))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`OrderItem\` ADD CONSTRAINT \`OrderItem_variantId_fkey\` FOREIGN KEY (\`variantId\`) REFERENCES \`ProductVariant\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE`,
    );
  }

  console.log("product_variants migration state is complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
