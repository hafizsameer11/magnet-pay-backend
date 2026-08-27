-- Seller flow: order tracking, store branding, product stock
ALTER TABLE `SellerStore` ADD COLUMN `bannerUrl` VARCHAR(191) NULL,
    ADD COLUMN `logoUrl` VARCHAR(191) NULL;

ALTER TABLE `Product` ADD COLUMN `stock` INTEGER NULL;

ALTER TABLE `MarketOrder` ADD COLUMN `tracking` VARCHAR(191) NULL,
    ADD COLUMN `carrier` VARCHAR(191) NULL,
    ADD COLUMN `sellerNote` TEXT NULL;
