-- Admin ops records (compliance, catalog meta, settings, support, etc.)
CREATE TABLE "AdminRecord" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "status" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminRecord_domain_idx" ON "AdminRecord"("domain");
CREATE INDEX "AdminRecord_domain_status_idx" ON "AdminRecord"("domain", "status");
