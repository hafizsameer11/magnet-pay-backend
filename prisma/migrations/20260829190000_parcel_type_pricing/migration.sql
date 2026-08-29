-- Parcel-type estimate pricing + logistics estimate config

CREATE TABLE "ParcelType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseMinor" INTEGER NOT NULL,
    "ratePerKgMinor" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParcelType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ParcelType_code_key" ON "ParcelType"("code");
CREATE INDEX "ParcelType_active_sortOrder_idx" ON "ParcelType"("active", "sortOrder");

CREATE TABLE "LogisticsEstimateConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "usdNgnEstimateRate" INTEGER NOT NULL DEFAULT 165000,
    "estimateDisclaimer" TEXT NOT NULL DEFAULT 'This is an estimate, not the final price. Final cost is set when goods clear customs. Any difference is credited to your ₦ wallet or requires top-up before collection.',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LogisticsEstimateConfig_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ShippingQuoteRequest" ADD COLUMN "parcelTypeId" TEXT;

CREATE INDEX "ShippingQuoteRequest_parcelTypeId_idx" ON "ShippingQuoteRequest"("parcelTypeId");

ALTER TABLE "ShippingQuoteRequest" ADD CONSTRAINT "ShippingQuoteRequest_parcelTypeId_fkey" FOREIGN KEY ("parcelTypeId") REFERENCES "ParcelType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "LogisticsEstimateConfig" ("id", "usdNgnEstimateRate", "estimateDisclaimer", "updatedAt")
VALUES (
    'default',
    165000,
    'This is an estimate, not the final price. Final cost is set when goods clear customs. Any difference is credited to your ₦ wallet or requires top-up before collection.',
    CURRENT_TIMESTAMP
);

INSERT INTO "ParcelType" ("id", "code", "name", "baseMinor", "ratePerKgMinor", "active", "sortOrder", "createdAt", "updatedAt") VALUES
    ('pt-general', 'general', 'General goods', 180000, 2500, true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('pt-apparel', 'apparel', 'Apparel & textiles', 150000, 1800, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('pt-electronics', 'electronics', 'Electronics', 220000, 3200, true, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('pt-auto_parts', 'auto_parts', 'Auto parts', 200000, 2800, true, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('pt-home_furniture', 'home_furniture', 'Home & furniture', 250000, 3500, true, 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
