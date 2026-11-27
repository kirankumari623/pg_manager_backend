import { Router } from "express";
import { z } from "zod";
import { BedStatus, BillStatus, ComplaintStatus, Prisma, Role, TenantStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";
import { currentMonthIST, IST_OFFSET_MS, startOfTodayIST } from "../../utils/dates";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must look like 2026-11");

const zero = () => new Prisma.Decimal(0);
const orZero = (value: Prisma.Decimal | null | undefined) => value ?? zero();
const percent = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

// GET /api/dashboard/owner?month=2026-11  (owner + staff)
// One call that returns everything the owner's home screen needs.
// "month" is optional and defaults to the current month (India time).
dashboardRouter.get(
  "/owner",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);

    const month = typeof req.query.month === "string" ? req.query.month : currentMonthIST();
    if (!monthSchema.safeParse(month).success) throw HttpError.badRequest("month must look like 2026-11");

    const [year, monthNumber] = month.split("-").map(Number);
    // Bill due dates are stored as plain dates...
    const monthStart = new Date(Date.UTC(year, monthNumber - 1, 1));
    const nextMonthStart = new Date(Date.UTC(year, monthNumber, 1));
    // ...but payments have a time, so their month boundaries are shifted to India time.
    const paymentsFrom = new Date(monthStart.getTime() - IST_OFFSET_MS);
    const paymentsTo = new Date(nextMonthStart.getTime() - IST_OFFSET_MS);

    // Unpaid bills past their due date, across ALL months.
    const overdueWhere: Prisma.BillWhereInput = {
      organizationId,
      status: { in: [BillStatus.UNPAID, BillStatus.PARTIAL] },
      dueDate: { lt: startOfTodayIST() },
    };

    const [bedGroups, tenantGroups, billsDue, received, overdueTotals, overdueByTenant, upcoming, recent, complaintGroups] =
      await Promise.all([
        prisma.bed.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } }),
        prisma.tenant.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } }),
        // Bills that fall due in the chosen month.
        prisma.bill.aggregate({
          where: {
            organizationId,
            status: { not: BillStatus.CANCELLED },
            dueDate: { gte: monthStart, lt: nextMonthStart },
          },
          _sum: { amount: true, paidAmount: true },
          _count: { _all: true },
        }),
        // Money actually received during the chosen month (whichever month it was for).
        prisma.payment.aggregate({
          where: { organizationId, paidAt: { gte: paymentsFrom, lt: paymentsTo } },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        prisma.bill.aggregate({
          where: overdueWhere,
          _sum: { amount: true, paidAmount: true },
          _count: { _all: true },
        }),
        prisma.bill.groupBy({
          by: ["tenantId"],
          where: overdueWhere,
          _sum: { amount: true, paidAmount: true },
          _min: { dueDate: true },
          _count: { _all: true },
        }),
        // Tenants who have given notice, soonest leaving first.
        prisma.stay.findMany({
          where: { organizationId, checkOutDate: null, expectedCheckOutDate: { not: null } },
          orderBy: { expectedCheckOutDate: "asc" },
          take: 10,
          select: {
            id: true,
            expectedCheckOutDate: true,
            tenant: { select: { id: true, name: true } },
            bed: { select: { label: true, room: { select: { roomNumber: true } } } },
          },
        }),
        prisma.payment.findMany({
          where: { organizationId },
          orderBy: { paidAt: "desc" },
          take: 5,
          select: {
            id: true,
            receiptNumber: true,
            amount: true,
            method: true,
            paidAt: true,
            tenant: { select: { id: true, name: true } },
          },
        }),
        // Complaints that still need attention.
        prisma.complaint.groupBy({
          by: ["status"],
          where: { organizationId, status: { in: [ComplaintStatus.OPEN, ComplaintStatus.IN_PROGRESS] } },
          _count: { _all: true },
        }),
      ]);

    // --- Occupancy ---
    const beds = { total: 0, occupied: 0, available: 0, reserved: 0, maintenance: 0 };
    for (const group of bedGroups) {
      const n = group._count._all;
      beds.total += n;
      if (group.status === BedStatus.OCCUPIED) beds.occupied += n;
      else if (group.status === BedStatus.AVAILABLE) beds.available += n;
      else if (group.status === BedStatus.RESERVED) beds.reserved += n;
      else if (group.status === BedStatus.MAINTENANCE) beds.maintenance += n;
    }

    // --- Tenants ---
    const tenantCount = (status: TenantStatus) =>
      tenantGroups.find((g) => g.status === status)?._count._all ?? 0;

    // --- Rent for the chosen month ---
    const billed = orZero(billsDue._sum.amount);
    const collected = orZero(billsDue._sum.paidAmount);

    // --- Overdue: who owes the most ---
    const owing = overdueByTenant
      .map((g) => ({
        tenantId: g.tenantId,
        amount: orZero(g._sum.amount).minus(orZero(g._sum.paidAmount)),
        billCount: g._count._all,
        oldestDueDate: g._min.dueDate,
      }))
      .sort((a, b) => b.amount.comparedTo(a.amount))
      .slice(0, 10);

    const tenantRows = owing.length
      ? await prisma.tenant.findMany({
          where: { organizationId, id: { in: owing.map((o) => o.tenantId) } },
          select: { id: true, name: true, phone: true },
        })
      : [];
    const tenantById = new Map(tenantRows.map((t) => [t.id, t]));

    res.json({
      month,
      occupancy: { ...beds, occupancyPercent: percent(beds.occupied, beds.total) },
      tenants: {
        active: tenantCount(TenantStatus.ACTIVE),
        onNotice: tenantCount(TenantStatus.NOTICE_PERIOD),
        pending: tenantCount(TenantStatus.PENDING),
        checkedOut: tenantCount(TenantStatus.CHECKED_OUT),
      },
      rent: {
        // Bills due this month
        billed,
        collected,
        pending: billed.minus(collected),
        billCount: billsDue._count._all,
        collectionPercent: percent(collected.toNumber(), billed.toNumber()),
        // Cash in hand this month, including late payments for older bills
        receivedInMonth: { amount: orZero(received._sum.amount), paymentCount: received._count._all },
      },
      overdue: {
        billCount: overdueTotals._count._all,
        amount: orZero(overdueTotals._sum.amount).minus(orZero(overdueTotals._sum.paidAmount)),
        topTenants: owing.map((o) => ({
          tenantId: o.tenantId,
          name: tenantById.get(o.tenantId)?.name ?? null,
          phone: tenantById.get(o.tenantId)?.phone ?? null,
          amount: o.amount,
          billCount: o.billCount,
          oldestDueDate: o.oldestDueDate,
        })),
      },
      complaints: {
        open: complaintGroups.find((g) => g.status === ComplaintStatus.OPEN)?._count._all ?? 0,
        inProgress: complaintGroups.find((g) => g.status === ComplaintStatus.IN_PROGRESS)?._count._all ?? 0,
      },
      upcomingVacancies: upcoming.map((s) => ({
        stayId: s.id,
        tenantId: s.tenant.id,
        tenantName: s.tenant.name,
        roomNumber: s.bed.room.roomNumber,
        bedLabel: s.bed.label,
        expectedCheckOutDate: s.expectedCheckOutDate,
      })),
      recentPayments: recent.map((p) => ({
        paymentId: p.id,
        receiptNumber: p.receiptNumber,
        amount: p.amount,
        method: p.method,
        paidAt: p.paidAt,
        tenantName: p.tenant.name,
      })),
    });
  })
);
