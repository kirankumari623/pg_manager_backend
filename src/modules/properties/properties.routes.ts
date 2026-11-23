import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";

// This module is the TEMPLATE for every future module (rooms, beds, tenants...):
//   1. authenticate + requireRole
//   2. get organizationId from the token with orgIdOf(req)
//   3. put organizationId in EVERY query's `where` (and in `data` when creating)

const propertySchema = z.object({
  name: z.string().trim().min(2),
  addressLine: z.string().trim().min(3),
  city: z.string().trim().min(2),
  state: z.string().trim().optional(),
  pincode: z.string().trim().optional(),
});

export const propertiesRouter = Router();
propertiesRouter.use(authenticate);

// GET /api/properties  (owner + staff)
propertiesRouter.get(
  "/",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    const properties = await prisma.property.findMany({
      where: { organizationId: orgIdOf(req) },
      orderBy: { createdAt: "desc" },
    });
    res.json({ properties });
  })
);

// POST /api/properties  (owner only)
propertiesRouter.post(
  "/",
  requireRole(Role.OWNER),
  validateBody(propertySchema),
  asyncHandler(async (req, res) => {
    const property = await prisma.property.create({
      data: { ...req.body, organizationId: orgIdOf(req) },
    });
    res.status(201).json({ property });
  })
);

// GET /api/properties/:id  (owner + staff)
propertiesRouter.get(
  "/:id",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    // Filtering by organizationId means another owner's property returns 404, not data.
    const property = await prisma.property.findFirst({
      where: { id: req.params.id, organizationId: orgIdOf(req) },
      include: { rooms: { include: { beds: true } } },
    });
    if (!property) throw HttpError.notFound("Property not found");
    res.json({ property });
  })
);
