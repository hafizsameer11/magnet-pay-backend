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

async function main() {
  if (!(await columnExists("Product", "stock"))) {
    await prisma.$executeRawUnsafe(`ALTER TABLE \`Product\` ADD COLUMN \`stock\` INTEGER NULL`);
    console.log("Added Product.stock");
  }
  for (const col of ["tracking", "carrier", "sellerNote"] as const) {
    if (!(await columnExists("MarketOrder", col))) {
      const ddl =
        col === "sellerNote"
          ? `ALTER TABLE \`MarketOrder\` ADD COLUMN \`${col}\` TEXT NULL`
          : `ALTER TABLE \`MarketOrder\` ADD COLUMN \`${col}\` VARCHAR(191) NULL`;
      await prisma.$executeRawUnsafe(ddl);
      console.log(`Added MarketOrder.${col}`);
    }
  }
  for (const col of ["bannerUrl", "logoUrl"] as const) {
    if (!(await columnExists("SellerStore", col))) {
      await prisma.$executeRawUnsafe(`ALTER TABLE \`SellerStore\` ADD COLUMN \`${col}\` VARCHAR(191) NULL`);
      console.log(`Added SellerStore.${col}`);
    }
  }
  console.log("seller_flow_fields columns verified.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
