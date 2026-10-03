-- Merchant till settings (alert reads, auto-print, biometric preference flags)

ALTER TABLE `Merchant` ADD COLUMN `settings` JSON NULL;
