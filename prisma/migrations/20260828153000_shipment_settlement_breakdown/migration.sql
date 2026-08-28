-- AlterTable
ALTER TABLE `ShipmentSettlement` ADD COLUMN `breakdown` JSON NULL,
    ADD COLUMN `notes` TEXT NULL;
