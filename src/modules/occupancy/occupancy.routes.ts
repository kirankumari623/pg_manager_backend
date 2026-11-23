import { Router } from "express";
import { BedStatus, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/asyncHandler";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";

export const occupancyRouter = Router();
occupancyRouter.use(authenticate);

function emptyCounts() {
  return { total: 0, occupied: 0, available: 0, reserved: 0, maintenance: 0 };
}

function addTo(counts: ReturnType<typeof emptyCounts>, status: BedStatus, n: number) {
  counts.total += n;
  if (status === BedStatus.OCCUPIED) counts.occupied += n;
  else if (status === BedStatus.AVAILABLE) counts.available += n;
  else if (status === BedStatus.RESERVED) counts.reserved += n;
  else if (status === BedStatus.MAINTENANCE) counts.maintenance += n;
}

const percent = (occupied: number, total: number) =>
  total === 0 ? 0 : Math.round((occupied / total) * 1000) / 10;

// GET /api/occupancy  (owner + staff)
// Returns bed counts for the whole organization and for each property.
// This feeds the "rooms occupied / available" part of the dashboard.
occupancyRouter.get(
  "/",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);

    // Load just the status and property of each bed, then count in code.
    // (Fine for a PG with hundreds of beds; can move to a database groupBy later.)
    const [properties, beds] = await Promise.all([
      prisma.property.findMany({
        where: { organizationId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.bed.findMany({
        where: { organizationId },
        select: { status: true, room: { select: { propertyId: true } } },
      }),
    ]);

    const overall = emptyCounts();
    const byProperty = new Map(properties.map((p) => [p.id, emptyCounts()]));

    for (const bed of beds) {
      addTo(overall, bed.status, 1);
      const counts = byProperty.get(bed.room.propertyId);
      if (counts) addTo(counts, bed.status, 1);
    }

    res.json({
      overall: { ...overall, occupancyPercent: percent(overall.occupied, overall.total) },
      properties: properties.map((p) => {
        const c = byProperty.get(p.id)!;
        return { propertyId: p.id, name: p.name, ...c, occupancyPercent: percent(c.occupied, c.total) };
      }),
    });
  })
);
