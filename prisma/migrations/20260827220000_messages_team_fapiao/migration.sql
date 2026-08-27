-- Conversation prefs, product tiers/variants, seller team, fapiao, user blocks

ALTER TABLE `ConversationParticipant`
    ADD COLUMN `pinnedAt` DATETIME(3) NULL,
    ADD COLUMN `muted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `archivedAt` DATETIME(3) NULL,
    ADD COLUMN `hiddenAt` DATETIME(3) NULL;

ALTER TABLE `Product`
    ADD COLUMN `variantAxes` JSON NULL,
    ADD COLUMN `pricingTiers` JSON NULL;

CREATE TABLE `SellerStoreMember` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `SellerStoreMember_storeId_userId_key`(`storeId`, `userId`),
    INDEX `SellerStoreMember_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SellerTeamInvite` (
    `id` VARCHAR(191) NOT NULL,
    `storeId` VARCHAR(191) NOT NULL,
    `token` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `role` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `invitedById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `SellerTeamInvite_token_key`(`token`),
    INDEX `SellerTeamInvite_phone_idx`(`phone`),
    INDEX `SellerTeamInvite_email_idx`(`email`),
    INDEX `SellerTeamInvite_storeId_status_idx`(`storeId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Fapiao` (
    `id` VARCHAR(191) NOT NULL,
    `sellerUserId` VARCHAR(191) NOT NULL,
    `buyerUserId` VARCHAR(191) NULL,
    `orderId` VARCHAR(191) NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` ENUM('NGN', 'CNY', 'USD') NOT NULL DEFAULT 'CNY',
    `vatRate` VARCHAR(191) NOT NULL DEFAULT '13',
    `uscc` VARCHAR(191) NULL,
    `documentUrl` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'issued',
    `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `Fapiao_sellerUserId_idx`(`sellerUserId`),
    INDEX `Fapiao_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `UserBlock` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `blockedUserId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `UserBlock_userId_blockedUserId_key`(`userId`, `blockedUserId`),
    INDEX `UserBlock_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SellerStoreMember` ADD CONSTRAINT `SellerStoreMember_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `SellerStore`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `SellerStoreMember` ADD CONSTRAINT `SellerStoreMember_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `SellerTeamInvite` ADD CONSTRAINT `SellerTeamInvite_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `SellerStore`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `Fapiao` ADD CONSTRAINT `Fapiao_sellerUserId_fkey` FOREIGN KEY (`sellerUserId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `Fapiao` ADD CONSTRAINT `Fapiao_buyerUserId_fkey` FOREIGN KEY (`buyerUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `UserBlock` ADD CONSTRAINT `UserBlock_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `UserBlock` ADD CONSTRAINT `UserBlock_blockedUserId_fkey` FOREIGN KEY (`blockedUserId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
