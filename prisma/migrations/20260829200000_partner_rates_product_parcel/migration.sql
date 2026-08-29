-- Partner rate cards, quote partner metadata, product/category parcel type

ALTER TABLE `Category` ADD COLUMN `defaultParcelTypeId` VARCHAR(191) NULL;
CREATE INDEX `Category_defaultParcelTypeId_idx` ON `Category`(`defaultParcelTypeId`);
ALTER TABLE `Category` ADD CONSTRAINT `Category_defaultParcelTypeId_fkey` FOREIGN KEY (`defaultParcelTypeId`) REFERENCES `ParcelType`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `Product` ADD COLUMN `parcelTypeId` VARCHAR(191) NULL;
CREATE INDEX `Product_parcelTypeId_idx` ON `Product`(`parcelTypeId`);
ALTER TABLE `Product` ADD CONSTRAINT `Product_parcelTypeId_fkey` FOREIGN KEY (`parcelTypeId`) REFERENCES `ParcelType`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `ShippingQuote` ADD COLUMN `partnerId` VARCHAR(191) NULL;
ALTER TABLE `ShippingQuote` ADD COLUMN `etaLabel` VARCHAR(191) NULL;
ALTER TABLE `ShippingQuote` ADD COLUMN `serviceLabel` VARCHAR(191) NULL;
ALTER TABLE `ShippingQuote` ADD COLUMN `badgeLabel` VARCHAR(191) NULL;
ALTER TABLE `ShippingQuote` ADD COLUMN `includes` JSON NULL;
ALTER TABLE `ShippingQuote` ADD COLUMN `ecoFriendly` BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX `ShippingQuote_partnerId_idx` ON `ShippingQuote`(`partnerId`);
ALTER TABLE `ShippingQuote` ADD CONSTRAINT `ShippingQuote_partnerId_fkey` FOREIGN KEY (`partnerId`) REFERENCES `LogisticsPartner`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `LogisticsPartnerRate` (
    `id` VARCHAR(191) NOT NULL,
    `partnerId` VARCHAR(191) NOT NULL,
    `parcelTypeId` VARCHAR(191) NULL,
    `mode` ENUM('AIR', 'SEA', 'EXPRESS', 'CONSOLIDATED') NOT NULL DEFAULT 'SEA',
    `baseSurchargeMinor` INTEGER NOT NULL DEFAULT 0,
    `rateMultiplierBps` INTEGER NOT NULL DEFAULT 10000,
    `etaLabel` VARCHAR(191) NOT NULL DEFAULT '26–32 days',
    `badgeLabel` VARCHAR(191) NULL,
    `includes` JSON NOT NULL,
    `ecoFriendly` BOOLEAN NOT NULL DEFAULT false,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
);

CREATE INDEX `LogisticsPartnerRate_partnerId_mode_active_idx` ON `LogisticsPartnerRate`(`partnerId`, `mode`, `active`);
CREATE INDEX `LogisticsPartnerRate_parcelTypeId_idx` ON `LogisticsPartnerRate`(`parcelTypeId`);

ALTER TABLE `LogisticsPartnerRate` ADD CONSTRAINT `LogisticsPartnerRate_partnerId_fkey` FOREIGN KEY (`partnerId`) REFERENCES `LogisticsPartner`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `LogisticsPartnerRate` ADD CONSTRAINT `LogisticsPartnerRate_parcelTypeId_fkey` FOREIGN KEY (`parcelTypeId`) REFERENCES `ParcelType`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE `Category` SET `defaultParcelTypeId` = 'pt-apparel' WHERE `slug` IN ('apparel', 'beauty');
UPDATE `Category` SET `defaultParcelTypeId` = 'pt-electronics' WHERE `slug` = 'electronics';
UPDATE `Category` SET `defaultParcelTypeId` = 'pt-auto_parts' WHERE `slug` = 'machinery';
UPDATE `Category` SET `defaultParcelTypeId` = 'pt-home_furniture' WHERE `slug` IN ('home', 'industrial');
