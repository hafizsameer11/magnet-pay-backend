-- Merchant module: UserRole MERCHANT + agent network tables

-- AlterEnum UserRole
ALTER TABLE `User` MODIFY COLUMN `role` ENUM('BUYER', 'SELLER', 'BOTH', 'MERCHANT') NOT NULL DEFAULT 'BUYER';

-- CreateTable
CREATE TABLE `Merchant` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `agentId` VARCHAR(191) NOT NULL,
    `tag` VARCHAR(191) NOT NULL,
    `businessName` VARCHAR(191) NOT NULL,
    `businessType` ENUM('REGISTERED', 'UNREGISTERED') NOT NULL DEFAULT 'REGISTERED',
    `category` VARCHAR(191) NOT NULL DEFAULT 'General',
    `address` VARCHAR(191) NOT NULL DEFAULT '',
    `state` VARCHAR(191) NOT NULL DEFAULT 'Lagos',
    `lga` VARCHAR(191) NOT NULL DEFAULT 'Ikeja',
    `lat` DOUBLE NULL,
    `lng` DOUBLE NULL,
    `phone` VARCHAR(191) NOT NULL,
    `ownerName` VARCHAR(191) NOT NULL DEFAULT '',
    `bvnLast4` VARCHAR(191) NULL,
    `bvnVerified` BOOLEAN NOT NULL DEFAULT false,
    `ninVerified` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED') NOT NULL DEFAULT 'PENDING',
    `tier` ENUM('SILVER', 'GOLD', 'PLATINUM') NOT NULL DEFAULT 'SILVER',
    `dailyLimit` INTEGER NOT NULL DEFAULT 30000000,
    `premiumPartner` BOOLEAN NOT NULL DEFAULT false,
    `listedInDirectory` BOOLEAN NOT NULL DEFAULT true,
    `settlementBank` VARCHAR(191) NULL,
    `settlementAccount` VARCHAR(191) NULL,
    `settlementAccountName` VARCHAR(191) NULL,
    `vaBank` VARCHAR(191) NOT NULL DEFAULT 'Wema Bank',
    `vaAccountNumber` VARCHAR(191) NULL,
    `passcodeHash` VARCHAR(191) NULL,
    `passcodeFailCount` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `unpaidEarningsMinor` BIGINT NOT NULL DEFAULT 0,
    `openHours` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Merchant_userId_key`(`userId`),
    UNIQUE INDEX `Merchant_agentId_key`(`agentId`),
    UNIQUE INDEX `Merchant_tag_key`(`tag`),
    INDEX `Merchant_status_idx`(`status`),
    INDEX `Merchant_state_lga_idx`(`state`, `lga`),
    INDEX `Merchant_tier_idx`(`tier`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MerchantDocument` (
    `id` VARCHAR(191) NOT NULL,
    `merchantId` VARCHAR(191) NOT NULL,
    `kind` ENUM('CAC', 'GOV_ID', 'SHOP_PHOTO', 'UTILITY') NOT NULL,
    `fileUrl` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `rejectReason` VARCHAR(191) NULL,
    `reviewedById` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MerchantDocument_merchantId_status_idx`(`merchantId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MerchantFloat` (
    `id` VARCHAR(191) NOT NULL,
    `merchantId` VARCHAR(191) NOT NULL,
    `cashMinor` BIGINT NOT NULL DEFAULT 0,
    `digitalMinor` BIGINT NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MerchantFloat_merchantId_key`(`merchantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Biller` (
    `id` VARCHAR(191) NOT NULL,
    `category` ENUM('AIRTIME', 'DATA', 'POWER', 'CABLE') NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `logoUrl` VARCHAR(191) NULL,
    `brandColor` VARCHAR(191) NOT NULL DEFAULT '#0E3B2E',
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Biller_category_enabled_idx`(`category`, `enabled`),
    UNIQUE INDEX `Biller_category_name_key`(`category`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BillerPlan` (
    `id` VARCHAR(191) NOT NULL,
    `billerId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `priceMinor` INTEGER NOT NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,

    INDEX `BillerPlan_billerId_idx`(`billerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MerchantTransaction` (
    `id` VARCHAR(191) NOT NULL,
    `ref` VARCHAR(191) NOT NULL,
    `merchantId` VARCHAR(191) NOT NULL,
    `kind` ENUM('CASH_IN', 'CASH_OUT', 'BILL', 'TRANSFER') NOT NULL,
    `amountMinor` BIGINT NOT NULL,
    `platformFeeMinor` BIGINT NOT NULL DEFAULT 0,
    `agentFeeMinor` BIGINT NOT NULL DEFAULT 0,
    `customerTotalMinor` BIGINT NOT NULL DEFAULT 0,
    `counterparty` VARCHAR(191) NULL,
    `counterpartyName` VARCHAR(191) NULL,
    `billerId` VARCHAR(191) NULL,
    `billAccount` VARCHAR(191) NULL,
    `token` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'COMPLETED', 'FAILED', 'REVERSED', 'DISPUTED') NOT NULL DEFAULT 'PENDING',
    `meta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MerchantTransaction_ref_key`(`ref`),
    INDEX `MerchantTransaction_merchantId_createdAt_idx`(`merchantId`, `createdAt`),
    INDEX `MerchantTransaction_status_idx`(`status`),
    INDEX `MerchantTransaction_kind_idx`(`kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MerchantSettlement` (
    `id` VARCHAR(191) NOT NULL,
    `merchantId` VARCHAR(191) NOT NULL,
    `amountMinor` BIGINT NOT NULL,
    `bank` VARCHAR(191) NOT NULL,
    `accountLast4` VARCHAR(191) NOT NULL,
    `batchDate` DATE NOT NULL,
    `status` ENUM('QUEUED', 'PAID', 'FAILED', 'HELD') NOT NULL DEFAULT 'QUEUED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MerchantSettlement_merchantId_batchDate_idx`(`merchantId`, `batchDate`),
    INDEX `MerchantSettlement_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SettlementBankChange` (
    `id` VARCHAR(191) NOT NULL,
    `merchantId` VARCHAR(191) NOT NULL,
    `oldBank` VARCHAR(191) NULL,
    `oldAccount` VARCHAR(191) NULL,
    `newBank` VARCHAR(191) NOT NULL,
    `newAccount` VARCHAR(191) NOT NULL,
    `newAccountName` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'APPROVED', 'DENIED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `pauseUntil` DATETIME(3) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decidedAt` DATETIME(3) NULL,

    INDEX `SettlementBankChange_merchantId_status_idx`(`merchantId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FloatAdjustment` (
    `id` VARCHAR(191) NOT NULL,
    `merchantId` VARCHAR(191) NOT NULL,
    `amountMinor` BIGINT NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'DENIED') NOT NULL DEFAULT 'PENDING',
    `requestedById` VARCHAR(191) NOT NULL,
    `approvedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decidedAt` DATETIME(3) NULL,

    INDEX `FloatAdjustment_merchantId_status_idx`(`merchantId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MerchantFeeRule` (
    `id` VARCHAR(191) NOT NULL,
    `service` VARCHAR(191) NOT NULL,
    `minAmount` INTEGER NOT NULL DEFAULT 0,
    `maxAmount` INTEGER NULL,
    `feeType` VARCHAR(191) NOT NULL,
    `value` INTEGER NOT NULL,
    `tier` VARCHAR(191) NULL,
    `effectiveFrom` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `MerchantFeeRule_service_effectiveFrom_idx`(`service`, `effectiveFrom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MerchantTierRule` (
    `id` VARCHAR(191) NOT NULL,
    `tier` ENUM('SILVER', 'GOLD', 'PLATINUM') NOT NULL,
    `monthlyVolumeThreshold` BIGINT NOT NULL DEFAULT 0,
    `dailyLimitMinor` INTEGER NOT NULL,
    `singleLimitMinor` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MerchantTierRule_tier_key`(`tier`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MerchantDispute` (
    `id` VARCHAR(191) NOT NULL,
    `txRef` VARCHAR(191) NULL,
    `merchantId` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `assigneeId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MerchantDispute_merchantId_status_idx`(`merchantId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MerchantReferral` (
    `id` VARCHAR(191) NOT NULL,
    `referrerId` VARCHAR(191) NOT NULL,
    `referredId` VARCHAR(191) NOT NULL,
    `rewardMinor` BIGINT NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `MerchantReferral_referrerId_referredId_key`(`referrerId`, `referredId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MerchantStaff` (
    `id` VARCHAR(191) NOT NULL,
    `merchantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT 'cashier',
    `permissions` JSON NULL,
    `passcodeHash` VARCHAR(191) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `MerchantStaff_merchantId_idx`(`merchantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MerchantBranch` (
    `id` VARCHAR(191) NOT NULL,
    `merchantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `address` VARCHAR(191) NOT NULL DEFAULT '',
    `cashMinor` BIGINT NOT NULL DEFAULT 0,
    `digitalMinor` BIGINT NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `MerchantBranch_merchantId_idx`(`merchantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Merchant` ADD CONSTRAINT `Merchant_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `MerchantDocument` ADD CONSTRAINT `MerchantDocument_merchantId_fkey` FOREIGN KEY (`merchantId`) REFERENCES `Merchant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `MerchantDocument` ADD CONSTRAINT `MerchantDocument_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `MerchantFloat` ADD CONSTRAINT `MerchantFloat_merchantId_fkey` FOREIGN KEY (`merchantId`) REFERENCES `Merchant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `BillerPlan` ADD CONSTRAINT `BillerPlan_billerId_fkey` FOREIGN KEY (`billerId`) REFERENCES `Biller`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `MerchantTransaction` ADD CONSTRAINT `MerchantTransaction_merchantId_fkey` FOREIGN KEY (`merchantId`) REFERENCES `Merchant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `MerchantTransaction` ADD CONSTRAINT `MerchantTransaction_billerId_fkey` FOREIGN KEY (`billerId`) REFERENCES `Biller`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `MerchantSettlement` ADD CONSTRAINT `MerchantSettlement_merchantId_fkey` FOREIGN KEY (`merchantId`) REFERENCES `Merchant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SettlementBankChange` ADD CONSTRAINT `SettlementBankChange_merchantId_fkey` FOREIGN KEY (`merchantId`) REFERENCES `Merchant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `FloatAdjustment` ADD CONSTRAINT `FloatAdjustment_merchantId_fkey` FOREIGN KEY (`merchantId`) REFERENCES `Merchant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `FloatAdjustment` ADD CONSTRAINT `FloatAdjustment_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `FloatAdjustment` ADD CONSTRAINT `FloatAdjustment_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `MerchantDispute` ADD CONSTRAINT `MerchantDispute_merchantId_fkey` FOREIGN KEY (`merchantId`) REFERENCES `Merchant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `MerchantDispute` ADD CONSTRAINT `MerchantDispute_txRef_fkey` FOREIGN KEY (`txRef`) REFERENCES `MerchantTransaction`(`ref`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `MerchantReferral` ADD CONSTRAINT `MerchantReferral_referrerId_fkey` FOREIGN KEY (`referrerId`) REFERENCES `Merchant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `MerchantReferral` ADD CONSTRAINT `MerchantReferral_referredId_fkey` FOREIGN KEY (`referredId`) REFERENCES `Merchant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `MerchantStaff` ADD CONSTRAINT `MerchantStaff_merchantId_fkey` FOREIGN KEY (`merchantId`) REFERENCES `Merchant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `MerchantBranch` ADD CONSTRAINT `MerchantBranch_merchantId_fkey` FOREIGN KEY (`merchantId`) REFERENCES `Merchant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
