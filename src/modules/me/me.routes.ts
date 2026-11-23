import { Router } from "express";
import { z } from "zod";
import { BillStatus, Prisma, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";
import { startOfTodayIST } from "../../utils/dates";

// Everything a TENANT can see. Every query here is filtered by the tenant's own id,
// so a tenant can never read another tenant's bills or payments, even in the same PG.
// (Owners and staff cannot use these endpoints, and tenants cannot use the owner ones.)

const OPEN_STATUSES: BillStatus[] = [BillStatus.UNPAID, BillStatus.PARTIAL];

const billSelect = {
  id: true,
  type: true,
  description: true,
  periodMonth: true,
  amount: true,
  paidAmount: true,
  dueDate: true,
  status: true,
} satisfies Prisma.BillSelect;

const paymentSelect = {
  id: true,
  receiptNumber: true,
  amount: true,
  method: true,
  reference: true,
  paidAt: true,
  bill: { select: { id: true, type: true, description: true, periodMonth: true } },
} satisfies Prisma.PaymentSelect;

function withDerived<T extends { amount: Prisma.Decimal; paidAmount: Prisma.Decimal; status: BillStatus; dueDate: Date }>(
  bill: T
) {
  return {
    ...bill,
    // A cancelled bill is not owed, so its balance is 0.
    balance: bill.status === BillStatus.CANCELLED ? new Prisma.Decimal(0) : bill.amount.minus(bill.paidAmount),
    isOverdue: OPEN_STATUSES.includes(bill.status) && bill.dueDate < startOfTodayIST(),
  };
}

// Finds the tenant profile linked to the logged-in account.
async function ownTenant(userId: string, organizationId: string) {
  const tenant = await prisma.tenant.findFirst({
    where: { userId, organizationId },
    include: { organization: { select: { name: true, phone: true, email: true } } },
  });
  if (!tenant) throw HttpError.notFound("No tenant profile is linked to this account");
  return tenant;
}

export const meRouter = Router();
meRouter.use(authenticate, requireRole(Role.TENANT));

// GET /api/me/dashboard -> the tenant's home screen in one call
meRouter.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const tenant = await ownTenant(req.auth!.userId, organizationId);

    const [stay, openBills, recentPayments] = await Promise.all([
      // The tenant's current stay, if any.
      prisma.stay.findFirst({
        where: { tenantId: tenant.id, organizationId, checkOutDate: null },
        select: {
          id: true,
          checkInDate: true,
          noticeDate: true,
          expectedCheckOutDate: true,
          monthlyRent: true,
          securityDeposit: true,
          bed: {
            select: {
              label: true,
              room: {
                select: {
                  roomNumber: true,
                  floor: true,
                  sharingType: true,
                  hasAC: true,
                  hasAttachedBath: true,
                  property: { select: { name: true, addressLine: true, city: true } },
                },
              },
            },
          },
        },
      }),
      prisma.bill.findMany({
        where: { tenantId: tenant.id, organizationId, status: { in: OPEN_STATUSES } },
        orderBy: { dueDate: "asc" },
        select: billSelect,
      }),
      prisma.payment.findMany({
        where: { tenantId: tenant.id, organizationId },
        orderBy: { paidAt: "desc" },
        take: 5,
        select: paymentSelect,
      }),
    ]);

    const bills = openBills.map(withDerived);
    const sum = (items: { balance: Prisma.Decimal }[]) =>
      items.reduce((total, b) => total.plus(b.balance), new Prisma.Decimal(0));

    res.json({
      tenant: { id: tenant.id, name: tenant.name, phone: tenant.phone, email: tenant.email, status: tenant.status },
      // Who to contact about rent.
      pg: tenant.organization,
      stay,
      dues: {
        totalDue: sum(bills),
        overdueAmount: sum(bills.filter((b) => b.isOverdue)),
        openBillCount: bills.length,
        nextDueDate: bills[0]?.dueDate ?? null,
      },
      openBills: bills,
      recentPayments,
    });
  })
);

// GET /api/me/bills?status=PAID  -> all of the tenant's own bills
meRouter.get(
  "/bills",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const tenant = await ownTenant(req.auth!.userId, organizationId);

    const where: Prisma.BillWhereInput = { tenantId: tenant.id, organizationId };
    if (typeof req.query.status === "string") {
      const parsed = z.nativeEnum(BillStatus).safeParse(req.query.status.toUpperCase());
      if (!parsed.success) throw HttpError.badRequest("Invalid status");
      where.status = parsed.data;
    }

    const bills = await prisma.bill.findMany({
      where,
      orderBy: { dueDate: "desc" },
      select: billSelect,
      take: 500,
    });
    res.json({ bills: bills.map(withDerived) });
  })
);

// GET /api/me/payments  -> the tenant's own payment history
meRouter.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const tenant = await ownTenant(req.auth!.userId, organizationId);

    const payments = await prisma.payment.findMany({
      where: { tenantId: tenant.id, organizationId },
      orderBy: { paidAt: "desc" },
      select: paymentSelect,
      take: 500,
    });
    res.json({ payments });
  })
);

// GET /api/me/payments/:id  -> receipt for one of the tenant's own payments
meRouter.get(
  "/payments/:id",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const tenant = await ownTenant(req.auth!.userId, organizationId);

    // tenantId is part of the filter, so another tenant's receipt comes back as "not found".
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.id, tenantId: tenant.id, organizationId },
      include: {
        organization: { select: { name: true, phone: true, email: true } },
        bill: { select: { id: true, type: true, description: true, periodMonth: true, amount: true, paidAmount: true, status: true } },
        recordedBy: { select: { name: true } },
      },
    });
    if (!payment) throw HttpError.notFound("Payment not found");

    res.json({
      receipt: {
        receiptNumber: payment.receiptNumber,
        paidAt: payment.paidAt,
        amount: payment.amount,
        method: payment.method,
        reference: payment.reference,
        organization: payment.organization,
        tenant: { id: tenant.id, name: tenant.name, phone: tenant.phone },
        bill: { ...payment.bill, balanceNow: payment.bill.amount.minus(payment.bill.paidAmount) },
        receivedBy: payment.recordedBy?.name ?? null,
      },
    });
  })
);
