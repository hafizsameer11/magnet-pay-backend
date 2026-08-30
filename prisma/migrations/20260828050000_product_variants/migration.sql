DROP TABLE IF EXISTS `ProductVariant`;

CREATE TABLE `ProductVariant` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `sku` VARCHAR(191) NULL,
    `options` JSON NOT NULL,
    `priceMinor` BIGINT NOT NULL,
    `stock` INTEGER NULL,
    `imageUrl` VARCHAR(191) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProductVariant_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CartItem` ADD COLUMN `variantId` VARCHAR(191) NULL;
ALTER TABLE `CartItem` ADD COLUMN `variantKey` VARCHAR(191) NOT NULL DEFAULT '';

ALTER TABLE `OrderItem` ADD COLUMN `variantId` VARCHAR(191) NULL;
ALTER TABLE `OrderItem` ADD COLUMN `variantLabel` VARCHAR(191) NULL;

ALTER TABLE `CartItem` DROP FOREIGN KEY `CartItem_cartId_fkey`;
ALTER TABLE `CartItem` DROP FOREIGN KEY `CartItem_productId_fkey`;
DROP INDEX `CartItem_cartId_productId_key` ON `CartItem`;

CREATE UNIQUE INDEX `CartItem_cartId_productId_variantKey_key` ON `CartItem`(`cartId`, `productId`, `variantKey`);
CREATE INDEX `CartItem_productId_idx` ON `CartItem`(`productId`);

ALTER TABLE `CartItem` ADD CONSTRAINT `CartItem_cartId_fkey` FOREIGN KEY (`cartId`) REFERENCES `Cart`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CartItem` ADD CONSTRAINT `CartItem_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ProductVariant` ADD CONSTRAINT `ProductVariant_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CartItem` ADD CONSTRAINT `CartItem_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `OrderItem` ADD CONSTRAINT `OrderItem_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `ProductVariant`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
