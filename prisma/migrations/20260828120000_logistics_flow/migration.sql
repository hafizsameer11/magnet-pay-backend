ALTER TABLE `Product`
    ADD COLUMN `cbmPerUnit` DOUBLE NULL,
    ADD COLUMN `weightKgPerUnit` DOUBLE NULL,
    ADD COLUMN `originHub` VARCHAR(191) NULL,
    ADD COLUMN `leadTimeMin` INTEGER NULL,
    ADD COLUMN `leadTimeMax` INTEGER NULL,
    ADD COLUMN `packagingType` VARCHAR(191) NULL,
    ADD COLUMN `defaultIncoterm` VARCHAR(191) NULL DEFAULT 'FOB';

ALTER TABLE `MarketOrder`
    ADD COLUMN `shipmentId` VARCHAR(191) NULL,
    ADD COLUMN `deliveryMethod` ENUM('PICKUP', 'DOORSTEP') NULL,
    ADD COLUMN `deliveryAddress` JSON NULL,
    ADD COLUMN `logisticsStatus` ENUM('NOT_BOOKED', 'QUOTE_PENDING', 'BOOKED', 'IN_TRANSIT', 'DELIVERED') NOT NULL DEFAULT 'NOT_BOOKED';

ALTER TABLE `ShippingQuoteRequest`
    ADD COLUMN `orderId` VARCHAR(191) NULL,
    ADD COLUMN `destinationDelivery` ENUM('PICKUP', 'DOORSTEP') NULL;

CREATE TABLE `ShipmentClaim` (
    `id` VARCHAR(191) NOT NULL,
    `shipmentId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `amountMinor` BIGINT NULL,
    `currency` ENUM('NGN', 'CNY', 'USD') NOT NULL DEFAULT 'NGN',
    `description` TEXT NOT NULL,
    `evidenceUrls` JSON NOT NULL,
    `status` ENUM('OPEN', 'RESOLVED', 'REJECTED') NOT NULL DEFAULT 'OPEN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ShipmentClaim_shipmentId_idx`(`shipmentId`),
    INDEX `ShipmentClaim_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `MarketOrder_shipmentId_key` ON `MarketOrder`(`shipmentId`);
CREATE INDEX `MarketOrder_shipmentId_idx` ON `MarketOrder`(`shipmentId`);
CREATE INDEX `ShippingQuoteRequest_orderId_idx` ON `ShippingQuoteRequest`(`orderId`);

ALTER TABLE `MarketOrder` ADD CONSTRAINT `MarketOrder_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `Shipment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `ShippingQuoteRequest` ADD CONSTRAINT `ShippingQuoteRequest_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `MarketOrder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `ShipmentClaim` ADD CONSTRAINT `ShipmentClaim_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `Shipment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ShipmentClaim` ADD CONSTRAINT `ShipmentClaim_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
