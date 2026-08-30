CREATE TABLE `ParcelType` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `baseMinor` INTEGER NOT NULL,
    `ratePerKgMinor` INTEGER NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ParcelType_code_key`(`code`),
    INDEX `ParcelType_active_sortOrder_idx`(`active`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `LogisticsEstimateConfig` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'default',
    `usdNgnEstimateRate` INTEGER NOT NULL DEFAULT 165000,
    `estimateDisclaimer` TEXT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ShippingQuoteRequest` ADD COLUMN `parcelTypeId` VARCHAR(191) NULL;

CREATE INDEX `ShippingQuoteRequest_parcelTypeId_idx` ON `ShippingQuoteRequest`(`parcelTypeId`);

ALTER TABLE `ShippingQuoteRequest` ADD CONSTRAINT `ShippingQuoteRequest_parcelTypeId_fkey` FOREIGN KEY (`parcelTypeId`) REFERENCES `ParcelType`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO `LogisticsEstimateConfig` (`id`, `usdNgnEstimateRate`, `estimateDisclaimer`, `updatedAt`)
VALUES (
    'default',
    165000,
    'This is an estimate, not the final price. Final cost is set when goods clear customs. Any difference is credited to your NGN wallet or requires top-up before collection.',
    CURRENT_TIMESTAMP(3)
);

INSERT INTO `ParcelType` (`id`, `code`, `name`, `baseMinor`, `ratePerKgMinor`, `active`, `sortOrder`, `createdAt`, `updatedAt`) VALUES
    ('pt-general', 'general', 'General goods', 180000, 2500, true, 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('pt-apparel', 'apparel', 'Apparel & textiles', 150000, 1800, true, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('pt-electronics', 'electronics', 'Electronics', 220000, 3200, true, 2, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('pt-auto_parts', 'auto_parts', 'Auto parts', 200000, 2800, true, 3, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('pt-home_furniture', 'home_furniture', 'Home & furniture', 250000, 3500, true, 4, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
