-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('PICKUP', 'DOORSTEP');

-- CreateEnum
CREATE TYPE "LogisticsStatus" AS ENUM ('NOT_BOOKED', 'QUOTE_PENDING', 'BOOKED', 'IN_TRANSIT', 'DELIVERED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('OPEN', 'RESOLVED', 'REJECTED');

-- AlterTable Product
ALTER TABLE "Product" ADD COLUMN "cbmPerUnit" DOUBLE PRECISION,
ADD COLUMN "weightKgPerUnit" DOUBLE PRECISION,
ADD COLUMN "originHub" TEXT,
ADD COLUMN "leadTimeMin" INTEGER,
ADD COLUMN "leadTimeMax" INTEGER,
ADD COLUMN "packagingType" TEXT,
ADD COLUMN "defaultIncoterm" TEXT DEFAULT 'FOB';

-- AlterTable MarketOrder
ALTER TABLE "MarketOrder" ADD COLUMN "shipmentId" TEXT,
ADD COLUMN "deliveryMethod" "DeliveryMethod",
ADD COLUMN "deliveryAddress" JSONB,
ADD COLUMN "logisticsStatus" "LogisticsStatus" NOT NULL DEFAULT 'NOT_BOOKED';

-- AlterTable ShippingQuoteRequest
ALTER TABLE "ShippingQuoteRequest" ADD COLUMN "orderId" TEXT,
ADD COLUMN "destinationDelivery" "DeliveryMethod";

-- CreateTable ShipmentClaim
CREATE TABLE "ShipmentClaim" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountMinor" BIGINT,
    "currency" "Currency" NOT NULL DEFAULT 'NGN',
    "description" TEXT NOT NULL,
    "evidenceUrls" JSONB NOT NULL DEFAULT '[]',
    "status" "ClaimStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipmentClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketOrder_shipmentId_key" ON "MarketOrder"("shipmentId");

-- CreateIndex
CREATE INDEX "MarketOrder_shipmentId_idx" ON "MarketOrder"("shipmentId");

-- CreateIndex
CREATE INDEX "ShippingQuoteRequest_orderId_idx" ON "ShippingQuoteRequest"("orderId");

-- CreateIndex
CREATE INDEX "ShipmentClaim_shipmentId_idx" ON "ShipmentClaim"("shipmentId");

-- CreateIndex
CREATE INDEX "ShipmentClaim_userId_idx" ON "ShipmentClaim"("userId");

-- AddForeignKey
ALTER TABLE "MarketOrder" ADD CONSTRAINT "MarketOrder_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingQuoteRequest" ADD CONSTRAINT "ShippingQuoteRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MarketOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentClaim" ADD CONSTRAINT "ShipmentClaim_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentClaim" ADD CONSTRAINT "ShipmentClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
