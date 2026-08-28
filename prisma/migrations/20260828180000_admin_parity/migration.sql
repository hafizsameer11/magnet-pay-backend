-- Admin design parity: brands, product stats, order notes, dispute workflow

CREATE TABLE `Brand` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'verified',
    `country` VARCHAR(191) NOT NULL DEFAULT 'CN',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Brand_name_idx`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ProductView` (
    `id` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProductView_productId_createdAt_idx`(`productId`, `createdAt`),
    INDEX `ProductView_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Product`
    ADD COLUMN `brandId` VARCHAR(191) NULL,
    ADD COLUMN `moderationStatus` ENUM('ACTIVE', 'PENDING', 'REPORTED', 'HIDDEN', 'REJECTED') NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN `flagReason` VARCHAR(191) NULL,
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

CREATE INDEX `Product_brandId_idx` ON `Product`(`brandId`);

ALTER TABLE `Product`
    ADD CONSTRAINT `Product_brandId_fkey` FOREIGN KEY (`brandId`) REFERENCES `Brand`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `ProductView`
    ADD CONSTRAINT `ProductView_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ProductView`
    ADD CONSTRAINT `ProductView_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `OrderNote` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `authorId` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrderNote_orderId_idx`(`orderId`),
    INDEX `OrderNote_authorId_idx`(`authorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `OrderNote`
    ADD CONSTRAINT `OrderNote_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `MarketOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `OrderNote`
    ADD CONSTRAINT `OrderNote_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `Dispute`
    ADD COLUMN `assigneeId` VARCHAR(191) NULL,
    ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'OPEN',
    ADD COLUMN `priority` VARCHAR(191) NOT NULL DEFAULT 'normal',
    ADD COLUMN `ruling` TEXT NULL;

CREATE INDEX `Dispute_status_idx` ON `Dispute`(`status`);

ALTER TABLE `Dispute`
    ADD CONSTRAINT `Dispute_assigneeId_fkey` FOREIGN KEY (`assigneeId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
