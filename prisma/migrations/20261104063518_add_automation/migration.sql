-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "autoRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoRentDueDay" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "autoRentEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoSendBills" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reminderEveryDays" INTEGER NOT NULL DEFAULT 3;
