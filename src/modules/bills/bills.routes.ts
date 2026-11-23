import { Router } from "express";
import { z } from "zod";
import { BillStatus, BillType, PaymentMethod, Prisma, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";
import { startOfTodayIST } from "../../utils/dates";
import { generateRentBills } from "./bills.service";

// Bills are the charges (rent, electricity...). Payments are the money received.
// A bill's status moves: UNPAID -> PARTIAL -> PAID. "Overdue" is not a status;
// it is worked out on the fly: not fully paid AND past its due date.

const money = z.coerce.number().positive().multipleOf(0.01); // max 2 decimal places
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use the format YYYY-MM, e.g. 2026-11");

const generateSchema = z.object({
  month: monthSchema,
  // Day of the month rent is due (1-28). Defaults to the 5th.
  dueDay: z.coerce.number().int().min(1).max(28).default(5),
});

const manualBillSchema = z.object({
  stayId: z.string().min(1),
  type: z.enum([BillType.ELECTRICITY, BillType.LATE_FEE, BillType.OTHER] as const),
  amount: money,
  dueDate: z.coerce.date(),
  description: z.string().trim().min(2),
});

const paymentSchema = z.object({
  amount: money,
  method: z.nativeEnum(PaymentMethod),
  reference: z.string().trim().optional(),
  paidAt: z.coerce.date().optional(), // defaults to now
  notes: z.string().trim().optional(),
});

const OPEN_STATUSES: BillStatus[] = [BillStatus.UNPAID, BillStatus.PARTIAL];

// Adds the two handy fields the app always needs.
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

const billInclude = {
  tenant: { select: { id: true, name: true, phone: true } },
  stay: {
    select: {
      id: true,
      bed: { select: { label: true, room: { select: { roomNumber: true, propertyId: true } } } },
    },
  },
} satisfies Prisma.BillInclude;

export const billsRouter = Router();
billsRouter.use(authenticate);

// POST /api/bills/generate  (owner)  { "month": "2026-11", "dueDay": 5 }
// Creates one RENT bill for every stay that was active during that month (see bills.service.ts).
billsRouter.post(
  "/generate",
  requireRole(Role.OWNER),
  validateBody(generateSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const { month, dueDay } = req.body as z.infer<typeof generateSchema>;

    res.json(await generateRentBills(organizationId, month, dueDay));
  })
);

// POST /api/bills  (owner) -> a one-off charge: electricity, late fee, damages...
billsRouter.post(
  "/",
  requireRole(Role.OWNER),
  validateBody(manualBillSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const input = req.body as z.infer<typeof manualBillSchema>;

    const stay = await prisma.stay.findFirst({ where: { id: input.stayId, organizationId } });
    if (!stay) throw HttpError.notFound("Stay not found");

    const bill = await prisma.bill.create({
      data: {
        organizationId,
        stayId: stay.id,
        tenantId: stay.tenantId,
        type: input.type,
        amount: input.amount,
        dueDate: input.dueDate,
        description: input.description,
      },
      include: billInclude,
    });
    res.status(201).json({ bill: withDerived(bill) });
  })
);

// GET /api/bills?status=UNPAID&month=2026-11&overdue=true&tenantId=...&propertyId=...
billsRouter.get(
  "/",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    const where: Prisma.BillWhereInput = { organizationId: orgIdOf(req) };

    if (typeof req.query.status === "string") {
      const parsed = z.nativeEnum(BillStatus).safeParse(req.query.status.toUpperCase());
      if (!parsed.success) throw HttpError.badRequest("Invalid status");
      where.status = parsed.data;
    }
    if (typeof req.query.type === "string") {
      const parsed = z.nativeEnum(BillType).safeParse(req.query.type.toUpperCase());
      if (!parsed.success) throw HttpError.badRequest("Invalid type");
      where.type = parsed.data;
    }
    if (typeof req.query.month === "string") {
      const parsed = monthSchema.safeParse(req.query.month);
      if (!parsed.success) throw HttpError.badRequest("month must look like 2026-11");
      const [y, m] = req.query.month.split("-").map(Number);
      where.periodMonth = new Date(Date.UTC(y, m - 1, 1));
    }
    if (typeof req.query.tenantId === "string") where.tenantId = req.query.tenantId;
    if (typeof req.query.stayId === "string") where.stayId = req.query.stayId;
    if (typeof req.query.propertyId === "string") {
      where.stay = { bed: { room: { propertyId: req.query.propertyId } } };
    }
    // Overdue = not fully paid and past the due date.
    if (req.query.overdue === "true") {
      where.status = { in: OPEN_STATUSES };
      where.dueDate = { lt: startOfTodayIST() };
    }

    const bills = await prisma.bill.findMany({
      where,
      include: billInclude,
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      take: 500,
    });
    res.json({ bills: bills.map(withDerived) });
  })
);

// GET /api/bills/:id  (owner + staff) -> bill with its payments
billsRouter.get(
  "/:id",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    const bill = await prisma.bill.findFirst({
      where: { id: req.params.id, organizationId: orgIdOf(req) },
      include: { ...billInclude, payments: { orderBy: { paidAt: "desc" } } },
    });
    if (!bill) throw HttpError.notFound("Bill not found");
    res.json({ bill: withDerived(bill) });
  })
);

// POST /api/bills/:id/cancel  (owner) -> only if nothing has been paid on it
billsRouter.post(
  "/:id/cancel",
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const bill = await prisma.bill.findFirst({ where: { id: req.params.id, organizationId } });
    if (!bill) throw HttpError.notFound("Bill not found");
    if (bill.status === BillStatus.CANCELLED) throw HttpError.conflict("This bill is already cancelled");
    if (bill.paidAmount.gt(0)) {
      throw HttpError.conflict("Payments have been recorded on this bill, so it cannot be cancelled");
    }

    const updated = await prisma.bill.update({
      where: { id: bill.id },
      data: { status: BillStatus.CANCELLED },
      include: billInclude,
    });
    res.json({ bill: withDerived(updated) });
  })
);

// POST /api/bills/:id/reopen  (owner) -> undo a cancellation; the bill goes back to UNPAID
billsRouter.post(
  "/:id/reopen",
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const bill = await prisma.bill.findFirst({ where: { id: req.params.id, organizationId } });
    if (!bill) throw HttpError.notFound("Bill not found");
    if (bill.status !== BillStatus.CANCELLED) throw HttpError.conflict("Only a cancelled bill can be reopened");

    // A bill can only be cancelled while nothing has been paid on it, so it comes back as UNPAID.
    const updated = await prisma.bill.update({
      where: { id: bill.id },
      data: { status: BillStatus.UNPAID },
      include: billInclude,
    });
    res.json({ bill: withDerived(updated) });
  })
);

// POST /api/bills/:id/payments  (owner + staff) -> record money received (full or partial)
billsRouter.post(
  "/:id/payments",
  requireRole(Role.OWNER, Role.STAFF),
  validateBody(paymentSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const input = req.body as z.infer<typeof paymentSchema>;

    const result = await prisma.$transaction(async (tx) => {
      // Take the next receipt number FIRST. Updating the organization row also makes
      // simultaneous payments in the same PG wait for each other, so numbers never repeat
      // and two people can't both pay off the same balance.
      const org = await tx.organization.update({
        where: { id: organizationId },
        data: { receiptCounter: { increment: 1 } },
        select: { receiptCounter: true },
      });
      const receiptNumber = `RCP-${String(org.receiptCounter).padStart(6, "0")}`;

      const bill = await tx.bill.findFirst({ where: { id: req.params.id, organizationId } });
      if (!bill) throw HttpError.notFound("Bill not found");
      if (bill.status === BillStatus.CANCELLED) throw HttpError.conflict("This bill has been cancelled");
      if (bill.status === BillStatus.PAID) throw HttpError.conflict("This bill is already fully paid");

      const amount = new Prisma.Decimal(input.amount);
      const balance = bill.amount.minus(bill.paidAmount);
      if (amount.gt(balance)) {
        throw HttpError.badRequest(`Payment of ${amount} is more than the balance due (${balance})`);
      }

      const newPaid = bill.paidAmount.plus(amount);
      const updated = await tx.bill.updateMany({
        // paidAmount must still be what we read, otherwise someone else changed it.
        where: { id: bill.id, paidAmount: bill.paidAmount },
        data: { paidAmount: newPaid, status: newPaid.gte(bill.amount) ? BillStatus.PAID : BillStatus.PARTIAL },
      });
      if (updated.count === 0) {
        throw HttpError.conflict("This bill was just updated by someone else. Please refresh and try again.");
      }

      const payment = await tx.payment.create({
        data: {
          organizationId,
          billId: bill.id,
          tenantId: bill.tenantId,
          amount,
          method: input.method,
          reference: input.reference,
          paidAt: input.paidAt ?? new Date(),
          receiptNumber,
          notes: input.notes,
          recordedById: req.auth!.userId,
        },
      });

      const freshBill = await tx.bill.findUniqueOrThrow({ where: { id: bill.id }, include: billInclude });
      return { payment, bill: freshBill };
    });

    res.status(201).json({ payment: result.payment, bill: withDerived(result.bill) });
  })
);
