-- CreateTable
CREATE TABLE `LogisticsPartner` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `kind` ENUM('FREIGHT_FORWARDER', 'WAREHOUSE', 'CUSTOMS_BROKER', 'LAST_MILE') NOT NULL DEFAULT 'FREIGHT_FORWARDER',
    `modes` JSON NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `rating` DOUBLE NULL,
    `serviceLabel` VARCHAR(191) NULL,
    `contactName` VARCHAR(191) NULL,
    `contactPhone` VARCHAR(191) NULL,
    `contactEmail` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `LogisticsPartner_code_key`(`code`),
    INDEX `LogisticsPartner_active_idx`(`active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FreightPricing` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'default',
    `airBaseMinor` INTEGER NOT NULL DEFAULT 450000,
    `seaBaseMinor` INTEGER NOT NULL DEFAULT 180000,
    `expressBaseMinor` INTEGER NOT NULL DEFAULT 600000,
    `consolidatedBaseMinor` INTEGER NOT NULL DEFAULT 220000,
    `cbmMultiplier` INTEGER NOT NULL DEFAULT 100000,
    `weightMultiplier` INTEGER NOT NULL DEFAULT 2500,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seed default freight pricing row
INSERT INTO `FreightPricing` (`id`, `airBaseMinor`, `seaBaseMinor`, `expressBaseMinor`, `consolidatedBaseMinor`, `cbmMultiplier`, `weightMultiplier`, `updatedAt`)
VALUES ('default', 450000, 180000, 600000, 220000, 100000, 2500, CURRENT_TIMESTAMP(3));
