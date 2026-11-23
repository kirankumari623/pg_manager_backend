import { Router } from "express";
import { z } from "zod";
import { BedStatus, Prisma, Role, SharingType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";

// How many beds a room gets by default for each sharing type.
const DEFAULT_BED_COUNT: Record<SharingType, number | null> = {
  SINGLE: 1,
  DOUBLE: 2,
  TRIPLE: 3,
  QUAD: 4,
  DORMITORY: null, // no default: the owner must say how many beds
};

const createRoomSchema = z.object({
  propertyId: z.string().min(1),
  roomNumber: z.string().trim().min(1),
  floor: z.coerce.number().int().default(0),
  sharingType: z.nativeEnum(SharingType),
  hasAttachedBath: z.boolean().default(false),
  hasAC: z.boolean().default(false),
  // Rent and deposit given here are applied to every bed created with the room.
  monthlyRent: z.coerce.number().nonnegative(),
  securityDeposit: z.coerce.number().nonnegative().default(0),
  // Optional: override the default bed count (required for DORMITORY).
  bedCount: z.coerce.number().int().min(1).max(50).optional(),
});

const updateRoomSchema = z
  .object({
    roomNumber: z.string().trim().min(1),
    floor: z.coerce.number().int(),
    sharingType: z.nativeEnum(SharingType),
    hasAttachedBath: z.boolean(),
    hasAC: z.boolean(),
  })
  .partial();

export const roomsRouter = Router();
roomsRouter.use(authenticate);

// POST /api/rooms  (owner)  -> creates a room AND its beds in one go
roomsRouter.post(
  "/",
  requireRole(Role.OWNER),
  validateBody(createRoomSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const { propertyId, monthlyRent, securityDeposit, bedCount, ...roomData } = req.body as z.infer<
      typeof createRoomSchema
    >;

    // Make sure the property belongs to THIS owner's organization.
    const property = await prisma.property.findFirst({ where: { id: propertyId, organizationId } });
    if (!property) throw HttpError.notFound("Property not found");

    const count = bedCount ?? DEFAULT_BED_COUNT[roomData.sharingType];
    if (!count) throw HttpError.badRequest("bedCount is required for a dormitory");

    // Room + beds are created together; if anything fails, nothing is saved.
    const room = await prisma.room.create({
      data: {
        ...roomData,
        organizationId,
        propertyId,
        beds: {
          create: Array.from({ length: count }, (_, i) => ({
            organizationId,
            label: String(i + 1),
            monthlyRent,
            securityDeposit,
          })),
        },
      },
      include: { beds: { orderBy: { label: "asc" } } },
    });
    res.status(201).json({ room });
  })
);

// GET /api/rooms?propertyId=...&status=AVAILABLE  (owner + staff)
// With status, only rooms that have at least one bed in that status are returned.
roomsRouter.get(
  "/",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    const where: Prisma.RoomWhereInput = { organizationId: orgIdOf(req) };

    if (typeof req.query.propertyId === "string") where.propertyId = req.query.propertyId;

    if (typeof req.query.status === "string") {
      const parsed = z.nativeEnum(BedStatus).safeParse(req.query.status.toUpperCase());
      if (!parsed.success) throw HttpError.badRequest("Invalid status");
      where.beds = { some: { status: parsed.data } };
    }

    const rooms = await prisma.room.findMany({
      where,
      include: { beds: { orderBy: { label: "asc" } } },
      orderBy: [{ propertyId: "asc" }, { floor: "asc" }, { roomNumber: "asc" }],
    });

    // Add handy counts so the app doesn't have to calculate them.
    const result = rooms.map((room) => ({
      ...room,
      totalBeds: room.beds.length,
      occupiedBeds: room.beds.filter((b) => b.status === BedStatus.OCCUPIED).length,
      availableBeds: room.beds.filter((b) => b.status === BedStatus.AVAILABLE).length,
    }));
    res.json({ rooms: result });
  })
);

// GET /api/rooms/:id  (owner + staff)
roomsRouter.get(
  "/:id",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    const room = await prisma.room.findFirst({
      where: { id: req.params.id, organizationId: orgIdOf(req) },
      include: { beds: { orderBy: { label: "asc" } }, property: true },
    });
    if (!room) throw HttpError.notFound("Room not found");
    res.json({ room });
  })
);

// PATCH /api/rooms/:id  (owner)
roomsRouter.patch(
  "/:id",
  requireRole(Role.OWNER),
  validateBody(updateRoomSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const existing = await prisma.room.findFirst({ where: { id: req.params.id, organizationId } });
    if (!existing) throw HttpError.notFound("Room not found");

    const room = await prisma.room.update({
      where: { id: existing.id },
      data: req.body,
      include: { beds: { orderBy: { label: "asc" } } },
    });
    res.json({ room });
  })
);

// DELETE /api/rooms/:id  (owner) -> blocked while anyone is living in it
roomsRouter.delete(
  "/:id",
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const room = await prisma.room.findFirst({
      where: { id: req.params.id, organizationId },
      include: { beds: true },
    });
    if (!room) throw HttpError.notFound("Room not found");

    if (room.beds.some((b) => b.status === BedStatus.OCCUPIED || b.status === BedStatus.RESERVED)) {
      throw HttpError.conflict("This room has occupied or reserved beds. Check out the tenants first.");
    }

    // Rooms whose beds have past tenants must be kept, so the history stays intact.
    const pastStays = await prisma.stay.count({ where: { bed: { roomId: room.id } } });
    if (pastStays > 0) {
      throw HttpError.conflict(
        "This room has tenant stay history and cannot be deleted. Set its beds to MAINTENANCE instead."
      );
    }

    await prisma.room.delete({ where: { id: room.id } });
    res.status(204).send();
  })
);
