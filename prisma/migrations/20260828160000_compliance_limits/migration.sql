-- CreateTable
CREATE TABLE `ComplianceLimits` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'default',
    `unverifiedNgnDailyCapMinor` INTEGER NOT NULL DEFAULT 0,
    `ngnTier1DailyCapMinor` INTEGER NOT NULL DEFAULT 50000000,
    `ngnTier2DailyCapMinor` INTEGER NOT NULL DEFAULT 2000000000,
    `cnyDailyCapMinor` INTEGER NOT NULL DEFAULT 20000000,
    `minTierDeposit` INTEGER NOT NULL DEFAULT 1,
    `minTierWithdraw` INTEGER NOT NULL DEFAULT 1,
    `minTierCrossBorder` INTEGER NOT NULL DEFAULT 2,
    `minTierMarketCheckout` INTEGER NOT NULL DEFAULT 2,
    `minTierLogistics` INTEGER NOT NULL DEFAULT 2,
    `allowBasicWhilePending` BOOLEAN NOT NULL DEFAULT true,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `ComplianceLimits` (
    `id`,
    `unverifiedNgnDailyCapMinor`,
    `ngnTier1DailyCapMinor`,
    `ngnTier2DailyCapMinor`,
    `cnyDailyCapMinor`,
    `minTierDeposit`,
    `minTierWithdraw`,
    `minTierCrossBorder`,
    `minTierMarketCheckout`,
    `minTierLogistics`,
    `allowBasicWhilePending`,
    `updatedAt`
) VALUES (
    'default',
    0,
    50000000,
    2000000000,
    20000000,
    1,
    1,
    2,
    2,
    2,
    true,
    CURRENT_TIMESTAMP(3)
);
