-- Admin-configurable seller product / logistics wizard options

ALTER TABLE `LogisticsEstimateConfig`
  ADD COLUMN `originHubs` JSON NULL,
  ADD COLUMN `packagingTypes` JSON NULL,
  ADD COLUMN `productSeaLclCnyPerCbm` INTEGER NOT NULL DEFAULT 320,
  ADD COLUMN `productDefaultDestination` VARCHAR(191) NOT NULL DEFAULT 'Apapa, Lagos',
  ADD COLUMN `productSeaTransitLabel` VARCHAR(191) NOT NULL DEFAULT '26–32 days',
  ADD COLUMN `productEstimateModeLabel` VARCHAR(191) NOT NULL DEFAULT 'sea LCL',
  ADD COLUMN `productEstimateFootnote` TEXT NULL;

UPDATE `LogisticsEstimateConfig`
SET
  `originHubs` = JSON_ARRAY(
    JSON_OBJECT('code', 'GZ', 'city', 'Guangzhou', 'hub', 'Baiyun · MagnetPay HQ', 'active', true, 'sortOrder', 0),
    JSON_OBJECT('code', 'YW', 'city', 'Yiwu', 'hub', 'Futian Market hub', 'active', true, 'sortOrder', 1),
    JSON_OBJECT('code', 'SZ', 'city', 'Shenzhen', 'hub', 'Yantian gateway', 'active', true, 'sortOrder', 2),
    JSON_OBJECT('code', 'NB', 'city', 'Ningbo', 'hub', 'Beilun port hub', 'active', true, 'sortOrder', 3)
  ),
  `packagingTypes` = JSON_ARRAY(
    JSON_OBJECT('name', 'Carton', 'active', true, 'sortOrder', 0),
    JSON_OBJECT('name', 'Pallet', 'active', true, 'sortOrder', 1),
    JSON_OBJECT('name', 'Crate', 'active', true, 'sortOrder', 2),
    JSON_OBJECT('name', 'Drum', 'active', true, 'sortOrder', 3),
    JSON_OBJECT('name', 'Bag', 'active', true, 'sortOrder', 4)
  ),
  `productEstimateFootnote` = 'Customs & clearing added on top by MagnetPay. Final amount locked in escrow.'
WHERE `id` = 'default';
