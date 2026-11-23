import { BillStatus, BillType } from "@prisma/client";
import { prisma } from "../../lib/prisma";

// Creates one RENT bill for every stay that was active during the given month ("2026-11").
// Safe to run more than once: stays that already have that month's bill are skipped.
// Bills the full monthly rent (no part-month proration yet).
// Used by both the "generate" endpoint and the daily automation.
export async function generateRentBills(organizationId: string, month: string, dueDay: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year, monthNumber - 1, 1));
  const nextMonthStart = new Date(Date.UTC(year, monthNumber, 1));
  const dueDate = new Date(Date.UTC(year, monthNumber - 1, dueDay));

  // Stays that began before the month ended and had not ended before it started.
  const stays = await prisma.stay.findMany({
    where: {
      organizationId,
      checkInDate: { lt: nextMonthStart },
      OR: [{ checkOutDate: null }, { checkOutDate: { gte: monthStart } }],
    },
    select: { id: true, tenantId: true, monthlyRent: true },
  });

  const result = await prisma.bill.createMany({
    data: stays.map((s) => ({
      organizationId,
      stayId: s.id,
      tenantId: s.tenantId,
      type: BillType.RENT,
      periodMonth: monthStart,
      amount: s.monthlyRent,
      dueDate,
      description: `Rent for ${month}`,
    })),
    skipDuplicates: true,
  });

  // Stays whose bill for this month exists but was cancelled on purpose. They are not billed again.
  // To bring one back, use POST /api/bills/:id/reopen.
  const cancelled = await prisma.bill.count({
    where: {
      organizationId,
      type: BillType.RENT,
      periodMonth: monthStart,
      status: BillStatus.CANCELLED,
      stayId: { in: stays.map((s) => s.id) },
    },
  });

  return {
    month,
    eligibleStays: stays.length,
    created: result.count,
    alreadyExisted: stays.length - result.count,
    skippedCancelled: cancelled, // already included in alreadyExisted
  };
}
