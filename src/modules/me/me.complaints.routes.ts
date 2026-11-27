import { Router } from "express";
import { z } from "zod";
import { ComplaintCategory, ComplaintPriority, ComplaintStatus, TenantStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { orgIdOf } from "../../middleware/auth";
import { commentSchema, commentsInclude } from "../complaints/complaints.shared";
import { ownTenant } from "./ownTenant";

// A tenant's own complaints. Mounted under /api/me/complaints (login and TENANT role are
// already checked by the parent router). Every query includes the tenant's id, so one
// tenant can never see another tenant's complaints.

const createSchema = z.object({
  category: z.nativeEnum(ComplaintCategory),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(3).max(2000),
  priority: z.nativeEnum(ComplaintPriority).optional(),
});

const MAX_OPEN_COMPLAINTS = 20;

export const meComplaintsRouter = Router();

// POST /api/me/complaints
meComplaintsRouter.post(
  "/",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const tenant = await ownTenant(req.auth!.userId, organizationId);
    if (tenant.status !== TenantStatus.ACTIVE && tenant.status !== TenantStatus.NOTICE_PERIOD) {
      throw HttpError.forbidden("Only tenants currently staying here can raise a complaint");
    }

    const openCount = await prisma.complaint.count({
      where: { tenantId: tenant.id, organizationId, status: { in: [ComplaintStatus.OPEN, ComplaintStatus.IN_PROGRESS] } },
    });
    if (openCount >= MAX_OPEN_COMPLAINTS) {
      throw new HttpError(429, "You have too many open complaints. Please wait until some are resolved.");
    }

    // Remember where the tenant stays, so the owner sees the building and room at a glance.
    const stay = await prisma.stay.findFirst({
      where: { tenantId: tenant.id, organizationId, checkOutDate: null },
      select: { bed: { select: { room: { select: { propertyId: true, roomNumber: true } } } } },
    });

    const complaint = await prisma.complaint.create({
      data: {
        ...req.body,
        organizationId,
        tenantId: tenant.id,
        propertyId: stay?.bed.room.propertyId ?? null,
        roomNumber: stay?.bed.room.roomNumber ?? null,
      },
    });
    res.status(201).json({ complaint });
  })
);

// GET /api/me/complaints?status=OPEN
meComplaintsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const tenant = await ownTenant(req.auth!.userId, organizationId);

    const where: { organizationId: string; tenantId: string; status?: ComplaintStatus } = { organizationId, tenantId: tenant.id };
    if (typeof req.query.status === "string") {
      const parsed = z.nativeEnum(ComplaintStatus).safeParse(req.query.status.toUpperCase());
      if (!parsed.success) throw HttpError.badRequest("Invalid status");
      where.status = parsed.data;
    }

    const complaints = await prisma.complaint.findMany({
      where,
      include: { _count: { select: { comments: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ complaints });
  })
);

// GET /api/me/complaints/:id -> with the conversation
meComplaintsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const tenant = await ownTenant(req.auth!.userId, organizationId);

    const complaint = await prisma.complaint.findFirst({
      where: { id: req.params.id, tenantId: tenant.id, organizationId },
      include: { comments: commentsInclude },
    });
    if (!complaint) throw HttpError.notFound("Complaint not found");
    res.json({ complaint });
  })
);

// POST /api/me/complaints/:id/comments  { "body": "Still not fixed" }
meComplaintsRouter.post(
  "/:id/comments",
  validateBody(commentSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const tenant = await ownTenant(req.auth!.userId, organizationId);

    const complaint = await prisma.complaint.findFirst({
      where: { id: req.params.id, tenantId: tenant.id, organizationId },
      select: { id: true, status: true },
    });
    if (!complaint) throw HttpError.notFound("Complaint not found");
    if (complaint.status === ComplaintStatus.CLOSED) throw HttpError.conflict("This complaint is closed");

    const comment = await prisma.complaintComment.create({
      data: { complaintId: complaint.id, authorId: req.auth!.userId, authorRole: req.auth!.role, body: req.body.body },
      select: { id: true, authorRole: true, body: true, createdAt: true, author: { select: { name: true } } },
    });
    res.status(201).json({ comment });
  })
);

// POST /api/me/complaints/:id/reopen -> "it is not actually fixed"
meComplaintsRouter.post(
  "/:id/reopen",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const tenant = await ownTenant(req.auth!.userId, organizationId);

    const complaint = await prisma.complaint.findFirst({
      where: { id: req.params.id, tenantId: tenant.id, organizationId },
      select: { id: true, status: true },
    });
    if (!complaint) throw HttpError.notFound("Complaint not found");
    if (complaint.status !== ComplaintStatus.RESOLVED) {
      throw HttpError.conflict("Only a resolved complaint can be reopened");
    }

    const updated = await prisma.complaint.update({
      where: { id: complaint.id },
      data: { status: ComplaintStatus.OPEN, resolvedAt: null },
      include: { comments: commentsInclude },
    });
    res.json({ complaint: updated });
  })
);
