import { Router } from "express";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";
import { dateOnly } from "../../utils/dateInput";
import { startOfTodayIST } from "../../utils/dates";
import { emailAnnouncement } from "./announcements.service";

// Notices from the owner. Tenants read them through GET /api/me/announcements.

const createSchema = z.object({
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(3).max(3000),
  // Leave out to show the notice to every tenant; set it to show it only to one property's tenants.
  propertyId: z.string().trim().min(1).optional(),
  isPinned: z.boolean().optional(),
  // Last day the notice is shown, like 2026-12-31. Leave out for no end date.
  expiresOn: dateOnly.optional(),
  // true = also email it to the tenants right now.
  sendEmail: z.boolean().optional(),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    body: z.string().trim().min(3).max(3000),
    propertyId: z.string().trim().min(1).nullable(), // null = back to "all tenants"
    isPinned: z.boolean(),
    expiresOn: dateOnly.nullable(), // null = never expires
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Send at least one field to change");

const emailSchema = z.object({ resend: z.boolean().optional() }).default({});

async function assertPropertyInOrg(organizationId: string, propertyId: string | null | undefined) {
  if (!propertyId) return;
  const property = await prisma.property.findFirst({ where: { id: propertyId, organizationId }, select: { id: true } });
  if (!property) throw HttpError.badRequest("Property not found");
}

const include = { property: { select: { id: true, name: true } } } as const;

export const announcementsRouter = Router();
announcementsRouter.use(authenticate);

// GET /api/announcements?active=true   (owner + staff)
announcementsRouter.get(
  "/",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    const where: Prisma.AnnouncementWhereInput = { organizationId: orgIdOf(req) };
    // active=true hides notices whose last day has passed.
    if (req.query.active === "true") where.OR = [{ expiresOn: null }, { expiresOn: { gte: startOfTodayIST() } }];

    const announcements = await prisma.announcement.findMany({
      where,
      include,
      orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
      take: 200,
    });
    res.json({ announcements });
  })
);

// POST /api/announcements   (owner only)
announcementsRouter.post(
  "/",
  requireRole(Role.OWNER),
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const { sendEmail, ...data } = req.body as z.infer<typeof createSchema>;
    await assertPropertyInOrg(organizationId, data.propertyId);

    const announcement = await prisma.announcement.create({
      data: { ...data, organizationId, createdById: req.auth!.userId },
      include,
    });

    // The notice is saved first, so a mail problem never loses it.
    const email = sendEmail ? await emailAnnouncement(organizationId, announcement.id) : undefined;
    res.status(201).json({ announcement: email ? { ...announcement, emailedAt: new Date() } : announcement, email });
  })
);

// PATCH /api/announcements/:id   (owner only)
announcementsRouter.patch(
  "/:id",
  requireRole(Role.OWNER),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const existing = await prisma.announcement.findFirst({ where: { id: req.params.id, organizationId }, select: { id: true } });
    if (!existing) throw HttpError.notFound("Announcement not found");
    await assertPropertyInOrg(organizationId, req.body.propertyId);

    const announcement = await prisma.announcement.update({ where: { id: existing.id }, data: req.body, include });
    res.json({ announcement });
  })
);

// DELETE /api/announcements/:id   (owner only)
announcementsRouter.delete(
  "/:id",
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    const result = await prisma.announcement.deleteMany({ where: { id: req.params.id, organizationId: orgIdOf(req) } });
    if (result.count === 0) throw HttpError.notFound("Announcement not found");
    res.json({ message: "Announcement deleted" });
  })
);

// POST /api/announcements/:id/email   { "resend": true }   (owner only)
// Emails the notice to the tenants. Refuses a second time unless resend is true.
announcementsRouter.post(
  "/:id/email",
  requireRole(Role.OWNER),
  validateBody(emailSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const existing = await prisma.announcement.findFirst({
      where: { id: req.params.id, organizationId },
      select: { id: true, emailedAt: true },
    });
    if (!existing) throw HttpError.notFound("Announcement not found");
    if (existing.emailedAt && !req.body.resend) {
      throw HttpError.conflict("This notice was already emailed. Send with { \"resend\": true } to email it again.");
    }

    const summary = await emailAnnouncement(organizationId, existing.id);
    res.json(summary);
  })
);
