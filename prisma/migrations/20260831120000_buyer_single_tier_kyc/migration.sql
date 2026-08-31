-- Buyers: single BVN/NIN tier — cross-border, checkout, and logistics require tier 1 (not tier 2 / liveness)
UPDATE `ComplianceLimits`
SET
  `minTierCrossBorder` = 1,
  `minTierMarketCheckout` = 1,
  `minTierLogistics` = 1
WHERE `id` = 'default';

-- Normalize approved buyer apps to tier 1 (Prembly BVN/NIN)
UPDATE `KycApplication`
SET `tier` = 1
WHERE `status` = 'APPROVED' AND `type` IN ('BVN', 'NIN');
