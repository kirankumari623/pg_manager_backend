import { Router } from "express";
import { z } from "zod";
import { PaymentMethod, Prisma, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";

// Payments are CREATED through POST /api/bills/:id/payments (see modules/bills).
// This module is for looking them up and getting receipt data.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown, name: string): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (isNaN(date.getTime())) throw HttpError.badRequest(`Invalid ${name} date: ${value}`);
  return date;
}

export const paymentsRouter = Router();
paymentsRouter.use(authenticate);
paymentsRouter.use(requireRole(Role.OWNER, Role.STAFF));

// GET /api/payments?from=2026-11-01&to=2026-11-30&method=UPI&tenantId=...&billId=...
paymentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const where: Prisma.PaymentWhereInput = { organizationId: orgIdOf(req) };

    if (typeof req.query.billId === "string") where.billId = req.query.billId;
    if (typeof req.query.tenantId === "string") where.tenantId = req.query.tenantId;
    if (typeof req.query.method === "string") {
      const parsed = z.nativeEnum(PaymentMethod).safeParse(req.query.method.toUpperCase());
      if (!parsed.success) throw HttpError.badRequest("Invalid method");
      where.method = parsed.data;
    }

    const from = parseDate(req.query.from, "from");
    const to = parseDate(req.query.to, "to");
    if (from || to) {
      const paidAt: Prisma.DateTimeFilter = {};
      if (from) paidAt.gte = from;
      if (to) {
        // "to=2026-11-30" should include everything paid on the 30th.
        if (DATE_ONLY.test(String(req.query.to))) paidAt.lt = new Date(to.getTime() + 24 * 60 * 60 * 1000);
        else paidAt.lte = to;
      }
      where.paidAt = paidAt;
    }

    const payments = await prisma.payment.findMany({
      where,
      include: {
        tenant: { select: { id: true, name: true, phone: true } },
        bill: { select: { id: true, type: true, description: true, periodMonth: true } },
      },
      orderBy: { paidAt: "desc" },
      take: 500,
    });

    // Handy total for whatever was filtered (e.g. "how much did we collect this month").
    const total = payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
    res.json({ payments, total });
  })
);

// GET /api/payments/:id -> everything needed to show or print a receipt
paymentsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.id, organizationId: orgIdOf(req) },
      include: {
        organization: { select: { name: true, phone: true, email: true } },
        tenant: { select: { id: true, name: true, phone: true, email: true } },
        bill: {
          select: {
            id: true,
            type: true,
            description: true,
            periodMonth: true,
            amount: true,
            paidAmount: true,
            status: true,
            stay: { select: { bed: { select: { label: true, room: { select: { roomNumber: true } } } } } },
          },
        },
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
        notes: payment.notes,
        organization: payment.organization,
        tenant: payment.tenant,
        bill: { ...payment.bill, balanceNow: payment.bill.amount.minus(payment.bill.paidAmount) },
        receivedBy: payment.recordedBy?.name ?? null,
      },
    });
  })
);
