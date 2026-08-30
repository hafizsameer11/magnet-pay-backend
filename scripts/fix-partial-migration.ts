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

async function main() {
  await prisma.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 0`);

  for (const [table, fk] of [
    ["CartItem", "CartItem_variantId_fkey"],
    ["OrderItem", "OrderItem_variantId_fkey"],
    ["ProductVariant", "ProductVariant_productId_fkey"],
    ["CartItem", "CartItem_cartId_fkey"],
    ["CartItem", "CartItem_productId_fkey"],
  ] as const) {
    if (await fkExists(table, fk)) {
      await prisma.$executeRawUnsafe(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${fk}\``);
    }
  }

  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS \`ProductVariant\``);

  for (const idx of ["CartItem_cartId_productId_variantKey_key", "CartItem_productId_idx"]) {
    if (await indexExists("CartItem", idx)) {
      await prisma.$executeRawUnsafe(`DROP INDEX \`${idx}\` ON \`CartItem\``);
    }
  }

  for (const col of ["variantId", "variantKey"]) {
    if (await columnExists("CartItem", col)) {
      await prisma.$executeRawUnsafe(`ALTER TABLE \`CartItem\` DROP COLUMN \`${col}\``);
    }
  }
  for (const col of ["variantId", "variantLabel"]) {
    if (await columnExists("OrderItem", col)) {
      await prisma.$executeRawUnsafe(`ALTER TABLE \`OrderItem\` DROP COLUMN \`${col}\``);
    }
  }

  if (!(await indexExists("CartItem", "CartItem_cartId_productId_key"))) {
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX \`CartItem_cartId_productId_key\` ON \`CartItem\`(\`cartId\`, \`productId\`)`,
    );
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

  await prisma.$executeRawUnsafe(`SET FOREIGN_KEY_CHECKS = 1`);
  console.log("Cleaned partial product_variants migration artifacts.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
