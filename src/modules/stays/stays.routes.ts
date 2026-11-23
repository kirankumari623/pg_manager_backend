import { Router } from "express";
import { z } from "zod";
import { BedStatus, BillStatus, Prisma, Role, TenantStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";

// A "stay" is one tenant living in one bed for a period of time.
// This module handles the whole life of a stay:
//   check-in  ->  (optional) notice  ->  check-out
// Each step changes the stay, the bed and the tenant TOGETHER inside a
// database transaction, so they can never get out of sync.

const checkInSchema = z.object({
  tenantId: z.string().min(1),
  bedId: z.string().min(1),
  checkInDate: z.coerce.date().optional(), // defaults to now
  // If left out, the bed's current rent and deposit are used.
  monthlyRent: z.coerce.number().nonnegative().optional(),
  securityDeposit: z.coerce.number().nonnegative().optional(),
  notes: z.string().trim().optional(),
});

const noticeSchema = z.object({
  expectedCheckOutDate: z.coerce.date(),
});

const checkOutSchema = z.object({
  checkOutDate: z.coerce.date().optional(), // defaults to now
  depositRefunded: z.coerce.number().nonnegative().optional(),
  depositDeduction: z.coerce.number().nonnegative().optional(),
  notes: z.string().trim().optional(),
  // Set to true to check out even though the tenant still has unpaid bills.
  confirmOutstandingDues: z.boolean().optional(),
});

const stayInclude = {
  tenant: { select: { id: true, name: true, phone: true, status: true } },
  bed: { select: { id: true, label: true, room: { select: { id: true, roomNumber: true, propertyId: true } } } },
} satisfies Prisma.StayInclude;

export const staysRouter = Router();
staysRouter.use(authenticate);
staysRouter.use(requireRole(Role.OWNER, Role.STAFF));

// Loads a stay that belongs to this organization and has not ended yet.
async function getActiveStay(tx: Prisma.TransactionClient, id: string, organizationId: string) {
  const stay = await tx.stay.findFirst({ where: { id, organizationId } });
  if (!stay) throw HttpError.notFound("Stay not found");
  if (stay.checkOutDate) throw HttpError.conflict("This tenant has already checked out");
  return stay;
}

// POST /api/stays/check-in
staysRouter.post(
  "/check-in",
  validateBody(checkInSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const input = req.body as z.infer<typeof checkInSchema>;

    const stay = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id: input.tenantId, organizationId } });
      if (!tenant) throw HttpError.notFound("Tenant not found");
      if (tenant.status === TenantStatus.ACTIVE || tenant.status === TenantStatus.NOTICE_PERIOD) {
        throw HttpError.conflict("This tenant is already checked in. Check them out first.");
      }

      const bed = await tx.bed.findFirst({ where: { id: input.bedId, organizationId } });
      if (!bed) throw HttpError.notFound("Bed not found");

      // Claim the bed in a single step. If two people try to take the same bed
      // at the same moment, only one of them gets count = 1.
      const claimed = await tx.bed.updateMany({
        where: { id: bed.id, organizationId, status: BedStatus.AVAILABLE },
        data: { status: BedStatus.OCCUPIED, availableFrom: null },
      });
      if (claimed.count === 0) {
        throw HttpError.conflict(`This bed is not available (it is ${bed.status.toLowerCase()})`);
      }

      const created = await tx.stay.create({
        data: {
          organizationId,
          tenantId: tenant.id,
          bedId: bed.id,
          checkInDate: input.checkInDate ?? new Date(),
          monthlyRent: input.monthlyRent ?? bed.monthlyRent,
          securityDeposit: input.securityDeposit ?? bed.securityDeposit,
          notes: input.notes,
        },
        include: stayInclude,
      });

      await tx.tenant.update({ where: { id: tenant.id }, data: { status: TenantStatus.ACTIVE } });
      // Read again so the response shows the tenant's new status, not the old one.
      return tx.stay.findUniqueOrThrow({ where: { id: created.id }, include: stayInclude });
    });

    res.status(201).json({ stay });
  })
);

// POST /api/stays/:id/notice -> tenant gives notice; the bed shows "available from" that date
staysRouter.post(
  "/:id/notice",
  validateBody(noticeSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const { expectedCheckOutDate } = req.body as z.infer<typeof noticeSchema>;

    const stay = await prisma.$transaction(async (tx) => {
      const current = await getActiveStay(tx, req.params.id, organizationId);
      if (expectedCheckOutDate < current.checkInDate) {
        throw HttpError.badRequest("Expected check-out date cannot be before the check-in date");
      }

      const updated = await tx.stay.update({
        where: { id: current.id },
        data: { noticeDate: current.noticeDate ?? new Date(), expectedCheckOutDate },
        include: stayInclude,
      });
      await tx.tenant.update({ where: { id: current.tenantId }, data: { status: TenantStatus.NOTICE_PERIOD } });
      // The bed stays OCCUPIED until the tenant actually leaves.
      await tx.bed.update({ where: { id: current.bedId }, data: { availableFrom: expectedCheckOutDate } });
      return tx.stay.findUniqueOrThrow({ where: { id: updated.id }, include: stayInclude });
    });

    res.json({ stay });
  })
);

// POST /api/stays/:id/cancel-notice -> tenant changed their mind and is staying
staysRouter.post(
  "/:id/cancel-notice",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);

    const stay = await prisma.$transaction(async (tx) => {
      const current = await getActiveStay(tx, req.params.id, organizationId);
      if (!current.noticeDate) throw HttpError.conflict("This tenant has not given notice");

      const updated = await tx.stay.update({
        where: { id: current.id },
        data: { noticeDate: null, expectedCheckOutDate: null },
        include: stayInclude,
      });
      await tx.tenant.update({ where: { id: current.tenantId }, data: { status: TenantStatus.ACTIVE } });
      await tx.bed.update({ where: { id: current.bedId }, data: { availableFrom: null } });
      return tx.stay.findUniqueOrThrow({ where: { id: updated.id }, include: stayInclude });
    });

    res.json({ stay });
  })
);

// POST /api/stays/:id/check-out -> tenant leaves; the bed becomes available again
staysRouter.post(
  "/:id/check-out",
  validateBody(checkOutSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const input = req.body as z.infer<typeof checkOutSchema>;

    const result = await prisma.$transaction(async (tx) => {
      const current = await getActiveStay(tx, req.params.id, organizationId);

      // Unpaid money on this stay's bills (UNPAID or PARTIAL).
      const dues = await tx.bill.aggregate({
        where: { stayId: current.id, organizationId, status: { in: [BillStatus.UNPAID, BillStatus.PARTIAL] } },
        _sum: { amount: true, paidAmount: true },
      });
      const outstanding = (dues._sum.amount ?? new Prisma.Decimal(0)).minus(
        dues._sum.paidAmount ?? new Prisma.Decimal(0)
      );
      if (outstanding.gt(0) && !input.confirmOutstandingDues) {
        throw HttpError.conflict(
          `This tenant still owes ${outstanding}. Collect it first, or send "confirmOutstandingDues": true to check out anyway.`
        );
      }

      const checkOutDate = input.checkOutDate ?? new Date();
      if (checkOutDate < current.checkInDate) {
        throw HttpError.badRequest("Check-out date cannot be before the check-in date");
      }

      const refunded = input.depositRefunded ?? 0;
      const deducted = input.depositDeduction ?? 0;
      if (refunded + deducted > current.securityDeposit.toNumber()) {
        throw HttpError.badRequest(
          `Refund + deduction (${refunded + deducted}) cannot be more than the deposit held (${current.securityDeposit})`
        );
      }

      // Guard against two check-outs at the same moment.
      const ended = await tx.stay.updateMany({
        where: { id: current.id, checkOutDate: null },
        data: {
          checkOutDate,
          depositRefunded: input.depositRefunded,
          depositDeduction: input.depositDeduction,
          ...(input.notes ? { notes: input.notes } : {}),
        },
      });
      if (ended.count === 0) throw HttpError.conflict("This tenant has already checked out");

      await tx.tenant.update({ where: { id: current.tenantId }, data: { status: TenantStatus.CHECKED_OUT } });
      await tx.bed.update({
        where: { id: current.bedId },
        data: { status: BedStatus.AVAILABLE, availableFrom: null },
      });

      const stay = await tx.stay.findUniqueOrThrow({ where: { id: current.id }, include: stayInclude });
      return { stay, outstanding };
    });

    // outstandingDues is 0 unless the owner chose to check out with money still owed.
    res.json({ stay: result.stay, outstandingDues: result.outstanding });
  })
);

// GET /api/stays?active=true&propertyId=...  (owner + staff)
staysRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const where: Prisma.StayWhereInput = { organizationId: orgIdOf(req) };

    if (req.query.active === "true") where.checkOutDate = null;
    if (req.query.active === "false") where.checkOutDate = { not: null };
    if (typeof req.query.propertyId === "string") where.bed = { room: { propertyId: req.query.propertyId } };
    if (typeof req.query.tenantId === "string") where.tenantId = req.query.tenantId;

    const stays = await prisma.stay.findMany({
      where,
      include: stayInclude,
      orderBy: { checkInDate: "desc" },
    });
    res.json({ stays });
  })
);

// GET /api/stays/:id  (owner + staff)
staysRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const stay = await prisma.stay.findFirst({
      where: { id: req.params.id, organizationId: orgIdOf(req) },
      include: stayInclude,
    });
    if (!stay) throw HttpError.notFound("Stay not found");
    res.json({ stay });
  })
);
