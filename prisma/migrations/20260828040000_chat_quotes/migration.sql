-- Chat-linked quotes: conversation context + quote messages
ALTER TABLE `Conversation` ADD COLUMN `productId` VARCHAR(191) NULL,
    ADD COLUMN `latestQuoteId` VARCHAR(191) NULL;

ALTER TABLE `Message` ADD COLUMN `quoteId` VARCHAR(191) NULL;

ALTER TABLE `RfqQuote` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

ALTER TABLE `Message` ADD CONSTRAINT `Message_quoteId_fkey` FOREIGN KEY (`quoteId`) REFERENCES `RfqQuote`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `Message_quoteId_idx` ON `Message`(`quoteId`);
CREATE INDEX `RfqQuote_sellerId_idx` ON `RfqQuote`(`sellerId`);
