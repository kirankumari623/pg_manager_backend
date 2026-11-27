import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/asyncHandler";
import { orgIdOf } from "../../middleware/auth";
import { startOfTodayIST } from "../../utils/dates";
import { ownTenant } from "./ownTenant";

// The notices a tenant can read. Mounted under /api/me/announcements (login and TENANT role
// are already checked by the parent router).
export const meAnnouncementsRouter = Router();

// GET /api/me/announcements
// Notices for the whole PG plus notices for the tenant's own property, newest first (pinned on top).
// Notices past their last day are not shown.
meAnnouncementsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const tenant = await ownTenant(req.auth!.userId, organizationId);

    const stay = await prisma.stay.findFirst({
      where: { tenantId: tenant.id, organizationId, checkOutDate: null },
      select: { bed: { select: { room: { select: { propertyId: true } } } } },
    });
    const propertyId = stay?.bed.room.propertyId;

    const announcements = await prisma.announcement.findMany({
      where: {
        organizationId,
        AND: [
          { OR: [{ propertyId: null }, ...(propertyId ? [{ propertyId }] : [])] },
          { OR: [{ expiresOn: null }, { expiresOn: { gte: startOfTodayIST() } }] },
        ],
      },
      select: { id: true, title: true, body: true, isPinned: true, expiresOn: true, createdAt: true, property: { select: { name: true } } },
      orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
      take: 50,
    });
    res.json({ announcements });
  })
);
