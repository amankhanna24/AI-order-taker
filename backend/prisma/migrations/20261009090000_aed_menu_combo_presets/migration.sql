-- Smash & Go: AED / Asia/Dubai defaults, and fixed variants ("presets") for combo components.

-- AlterTable
ALTER TABLE "Restaurant" ALTER COLUMN "currency" SET DEFAULT 'AED',
ALTER COLUMN "timezone" SET DEFAULT 'Asia/Dubai';

-- AlterTable
ALTER TABLE "Location" ALTER COLUMN "country" SET DEFAULT 'UAE',
ALTER COLUMN "timezone" SET DEFAULT 'Asia/Dubai';

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "currency" SET DEFAULT 'AED';

-- CreateTable
CREATE TABLE "ComboComponentPreset" (
    "componentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "modifierId" TEXT NOT NULL,

    CONSTRAINT "ComboComponentPreset_pkey" PRIMARY KEY ("componentId","productId","modifierId")
);

-- AddForeignKey
ALTER TABLE "ComboComponentPreset" ADD CONSTRAINT "ComboComponentPreset_componentId_productId_fkey" FOREIGN KEY ("componentId", "productId") REFERENCES "ComboComponentProduct"("componentId", "productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboComponentPreset" ADD CONSTRAINT "ComboComponentPreset_modifierId_fkey" FOREIGN KEY ("modifierId") REFERENCES "Modifier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
