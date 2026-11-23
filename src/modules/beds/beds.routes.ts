import { Router } from "express";
import { z } from "zod";
import { BedStatus, Prisma, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";

const addBedSchema = z.object({
  roomId: z.string().min(1),
  label: z.string().trim().min(1),
  monthlyRent: z.coerce.number().nonnegative(),
  securityDeposit: z.coerce.number().nonnegative().default(0),
});

// The owner can only set these statuses by hand.
// OCCUPIED will be set automatically by check-in (built in the next chunk),
// and a tenant's check-out will free the bed again.
const MANUAL_STATUSES = [BedStatus.AVAILABLE, BedStatus.RESERVED, BedStatus.MAINTENANCE] as const;

const updateBedSchema = z
  .object({
    label: z.string().trim().min(1),
    monthlyRent: z.coerce.number().nonnegative(),
    securityDeposit: z.coerce.number().nonnegative(),
    status: z.enum(MANUAL_STATUSES),
  })
  .partial();

export const bedsRouter = Router();
bedsRouter.use(authenticate);

// POST /api/beds  (owner) -> add one more bed to an existing room
bedsRouter.post(
  "/",
  requireRole(Role.OWNER),
  validateBody(addBedSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const { roomId, ...data } = req.body as z.infer<typeof addBedSchema>;

    const room = await prisma.room.findFirst({ where: { id: roomId, organizationId } });
    if (!room) throw HttpError.notFound("Room not found");

    // The database also enforces unique labels per room; this gives a friendlier message.
    const duplicate = await prisma.bed.findFirst({ where: { roomId, label: data.label } });
    if (duplicate) throw HttpError.conflict(`This room already has a bed labelled "${data.label}"`);

    const bed = await prisma.bed.create({ data: { ...data, roomId, organizationId } });
    res.status(201).json({ bed });
  })
);

// GET /api/beds?status=AVAILABLE&propertyId=...  (owner + staff)
bedsRouter.get(
  "/",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    const where: Prisma.BedWhereInput = { organizationId: orgIdOf(req) };

    if (typeof req.query.status === "string") {
      const parsed = z.nativeEnum(BedStatus).safeParse(req.query.status.toUpperCase());
      if (!parsed.success) throw HttpError.badRequest("Invalid status");
      where.status = parsed.data;
    }
    if (typeof req.query.propertyId === "string") where.room = { propertyId: req.query.propertyId };

    const beds = await prisma.bed.findMany({
      where,
      include: { room: { select: { id: true, roomNumber: true, floor: true, propertyId: true } } },
      orderBy: [{ room: { roomNumber: "asc" } }, { label: "asc" }],
    });
    res.json({ beds });
  })
);

// PATCH /api/beds/:id  (owner) -> change rent, deposit, label or status
bedsRouter.patch(
  "/:id",
  requireRole(Role.OWNER),
  validateBody(updateBedSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const bed = await prisma.bed.findFirst({ where: { id: req.params.id, organizationId } });
    if (!bed) throw HttpError.notFound("Bed not found");

    // An occupied bed's status is controlled by check-in / check-out, not by hand.
    if (req.body.status && bed.status === BedStatus.OCCUPIED) {
      throw HttpError.conflict("This bed is occupied. Check the tenant out to free it.");
    }

    const updated = await prisma.bed.update({ where: { id: bed.id }, data: req.body });
    res.json({ bed: updated });
  })
);

// DELETE /api/beds/:id  (owner) -> blocked while occupied or reserved
bedsRouter.delete(
  "/:id",
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const bed = await prisma.bed.findFirst({ where: { id: req.params.id, organizationId } });
    if (!bed) throw HttpError.notFound("Bed not found");

    if (bed.status === BedStatus.OCCUPIED || bed.status === BedStatus.RESERVED) {
      throw HttpError.conflict("This bed is occupied or reserved and cannot be deleted.");
    }

    // Beds with past tenants must be kept, so the history stays intact.
    const pastStays = await prisma.stay.count({ where: { bedId: bed.id } });
    if (pastStays > 0) {
      throw HttpError.conflict(
        "This bed has tenant stay history and cannot be deleted. Set it to MAINTENANCE instead."
      );
    }

    await prisma.bed.delete({ where: { id: bed.id } });
    res.status(204).send();
  })
);
