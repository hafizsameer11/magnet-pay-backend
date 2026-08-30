-- Escrow inspection workflow
ALTER TABLE `Escrow` ADD COLUMN `inspectorId` VARCHAR(191) NULL;
ALTER TABLE `Escrow` ADD COLUMN `feeSplit` VARCHAR(191) NULL;
ALTER TABLE `Escrow` ADD COLUMN `autoReleaseHours` INTEGER NULL;
ALTER TABLE `Escrow` ADD COLUMN `requiredDocs` JSON NULL;

CREATE TABLE `Inspector` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `region` VARCHAR(191) NULL,
    `feeMinor` BIGINT NOT NULL DEFAULT 0,
    `rating` DOUBLE NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `InspectionRequest` (
    `id` VARCHAR(191) NOT NULL,
    `escrowId` VARCHAR(191) NOT NULL,
    `inspectorId` VARCHAR(191) NOT NULL,
    `status` ENUM('REQUESTED', 'SCHEDULED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'WAIVED') NOT NULL DEFAULT 'REQUESTED',
    `requiredDocs` JSON NULL,
    `reportUrl` VARCHAR(191) NULL,
    `failedReason` VARCHAR(191) NULL,
    `assignedToId` VARCHAR(191) NULL,
    `passedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `InspectionRequest_escrowId_idx`(`escrowId`),
    INDEX `InspectionRequest_status_idx`(`status`),
    INDEX `InspectionRequest_inspectorId_idx`(`inspectorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `InspectionRequest` ADD CONSTRAINT `InspectionRequest_escrowId_fkey` FOREIGN KEY (`escrowId`) REFERENCES `Escrow`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `InspectionRequest` ADD CONSTRAINT `InspectionRequest_inspectorId_fkey` FOREIGN KEY (`inspectorId`) REFERENCES `Inspector`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
