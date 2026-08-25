-- CreateEnum
CREATE TYPE "WasteStream" AS ENUM ('BIO', 'NON_BIO', 'HAZARDOUS', 'E_WASTE', 'OTHER');

-- CreateEnum
CREATE TYPE "CompanyStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('PENDING_PICKUP', 'PICKED', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "complaints" ADD COLUMN     "wasteStream" "WasteStream",
ADD COLUMN     "wasteStreamConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "wasteStreamOverridden" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT NOT NULL,
    "contactEmail" TEXT,
    "address" TEXT,
    "acceptedStreams" "WasteStream"[],
    "capacityKgPerDay" INTEGER NOT NULL DEFAULT 0,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isCityWide" BOOLEAN NOT NULL DEFAULT false,
    "status" "CompanyStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_wards" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "wardId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_wards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaint_assignments" (
    "id" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "assignedById" TEXT,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'PENDING_PICKUP',
    "wasteStream" "WasteStream" NOT NULL,
    "estimatedQuantity" "WasteQuantity" NOT NULL DEFAULT 'MEDIUM',
    "actualQuantityKg" DOUBLE PRECISION,
    "note" TEXT,
    "pickedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "complaint_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_code_key" ON "companies"("code");

-- CreateIndex
CREATE INDEX "companies_status_idx" ON "companies"("status");

-- CreateIndex
CREATE INDEX "company_wards_wardId_idx" ON "company_wards"("wardId");

-- CreateIndex
CREATE UNIQUE INDEX "company_wards_companyId_wardId_key" ON "company_wards"("companyId", "wardId");

-- CreateIndex
CREATE INDEX "complaint_assignments_complaintId_status_idx" ON "complaint_assignments"("complaintId", "status");

-- CreateIndex
CREATE INDEX "complaint_assignments_companyId_status_idx" ON "complaint_assignments"("companyId", "status");

-- CreateIndex
CREATE INDEX "complaint_assignments_assignedById_createdAt_idx" ON "complaint_assignments"("assignedById", "createdAt");

-- CreateIndex
CREATE INDEX "complaint_assignments_createdAt_idx" ON "complaint_assignments"("createdAt");

-- CreateIndex
CREATE INDEX "complaints_wardId_wasteStream_idx" ON "complaints"("wardId", "wasteStream");

-- AddForeignKey
ALTER TABLE "company_wards" ADD CONSTRAINT "company_wards_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_wards" ADD CONSTRAINT "company_wards_wardId_fkey" FOREIGN KEY ("wardId") REFERENCES "wards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_assignments" ADD CONSTRAINT "complaint_assignments_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "complaints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_assignments" ADD CONSTRAINT "complaint_assignments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaint_assignments" ADD CONSTRAINT "complaint_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

