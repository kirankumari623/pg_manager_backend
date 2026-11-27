import { Router } from "express";
import { z } from "zod";
import { ComplaintCategory, ComplaintPriority, ComplaintStatus, Prisma, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";
import { commentSchema, commentsInclude } from "./complaints.shared";

// What owners and staff use to handle tenants' complaints.
// (Tenants raise and follow their own complaints through /api/me/complaints.)

const updateSchema = z
  .object({
    status: z.nativeEnum(ComplaintStatus),
    priority: z.nativeEnum(ComplaintPriority),
    category: z.nativeEnum(ComplaintCategory),
    resolutionNote: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Send at least one field to change");

const DONE: ComplaintStatus[] = [ComplaintStatus.RESOLVED, ComplaintStatus.CLOSED];

// Reads an optional ?status=open style filter and checks it is one of the allowed values.
function enumFilter<T extends Record<string, string>>(raw: unknown, values: T, name: string): T[keyof T] | undefined {
  if (typeof raw !== "string") return undefined;
  const parsed = z.nativeEnum(values).safeParse(raw.toUpperCase());
  if (!parsed.success) throw HttpError.badRequest(`Invalid ${name}`);
  return parsed.data as T[keyof T];
}

export const complaintsRouter = Router();
complaintsRouter.use(authenticate, requireRole(Role.OWNER, Role.STAFF));

// GET /api/complaints?status=OPEN&category=WATER&priority=HIGH&tenantId=...&propertyId=...
complaintsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const where: Prisma.ComplaintWhereInput = { organizationId };

    const status = enumFilter(req.query.status, ComplaintStatus, "status");
    const category = enumFilter(req.query.category, ComplaintCategory, "category");
    const priority = enumFilter(req.query.priority, ComplaintPriority, "priority");
    if (status) where.status = status;
    if (category) where.category = category;
    if (priority) where.priority = priority;
    if (typeof req.query.tenantId === "string") where.tenantId = req.query.tenantId;
    if (typeof req.query.propertyId === "string") where.propertyId = req.query.propertyId;

    const [complaints, byStatus] = await Promise.all([
      prisma.complaint.findMany({
        where,
        include: {
          tenant: { select: { id: true, name: true, phone: true } },
          property: { select: { id: true, name: true } },
          _count: { select: { comments: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
      // Counts for the whole PG (ignoring the filters above), handy for tabs like "Open (3)".
      prisma.complaint.groupBy({ by: ["status"], where: { organizationId }, _count: { _all: true } }),
    ]);

    const count = (status: ComplaintStatus) => byStatus.find((g) => g.status === status)?._count._all ?? 0;
    res.json({
      complaints,
      counts: {
        open: count(ComplaintStatus.OPEN),
        inProgress: count(ComplaintStatus.IN_PROGRESS),
        resolved: count(ComplaintStatus.RESOLVED),
        closed: count(ComplaintStatus.CLOSED),
      },
    });
  })
);

// GET /api/complaints/:id -> the complaint with its whole conversation
complaintsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const complaint = await prisma.complaint.findFirst({
      where: { id: req.params.id, organizationId: orgIdOf(req) },
      include: {
        tenant: { select: { id: true, name: true, phone: true, email: true } },
        property: { select: { id: true, name: true } },
        comments: commentsInclude,
      },
    });
    if (!complaint) throw HttpError.notFound("Complaint not found");
    res.json({ complaint });
  })
);

// PATCH /api/complaints/:id  { "status": "IN_PROGRESS", "priority": "HIGH", "resolutionNote": "..." }
complaintsRouter.patch(
  "/:id",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const existing = await prisma.complaint.findFirst({
      where: { id: req.params.id, organizationId },
      select: { id: true, resolvedAt: true },
    });
    if (!existing) throw HttpError.notFound("Complaint not found");

    const data: Prisma.ComplaintUpdateInput = { ...req.body };
    if (req.body.status) {
      // The time of resolution is recorded once, and cleared if the complaint is opened again.
      if (DONE.includes(req.body.status)) data.resolvedAt = existing.resolvedAt ?? new Date();
      else data.resolvedAt = null;
    }

    await prisma.complaint.update({ where: { id: existing.id }, data });
    const complaint = await prisma.complaint.findFirst({
      where: { id: existing.id, organizationId },
      include: {
        tenant: { select: { id: true, name: true, phone: true } },
        property: { select: { id: true, name: true } },
        comments: commentsInclude,
      },
    });
    res.json({ complaint });
  })
);

// POST /api/complaints/:id/comments  { "body": "Plumber will come tomorrow" }
complaintsRouter.post(
  "/:id/comments",
  validateBody(commentSchema),
  asyncHandler(async (req, res) => {
    const complaint = await prisma.complaint.findFirst({
      where: { id: req.params.id, organizationId: orgIdOf(req) },
      select: { id: true },
    });
    if (!complaint) throw HttpError.notFound("Complaint not found");

    const comment = await prisma.complaintComment.create({
      data: { complaintId: complaint.id, authorId: req.auth!.userId, authorRole: req.auth!.role, body: req.body.body },
      select: { id: true, authorRole: true, body: true, createdAt: true, author: { select: { name: true } } },
    });
    res.status(201).json({ comment });
  })
);
