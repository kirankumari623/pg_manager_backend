import { Router } from "express";
import bcrypt from "bcryptjs";
import { makeTemporaryPassword } from "../../utils/password";
import { z } from "zod";
import { Gender, Prisma, Role, TenantStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";

// A tenant is a PERSON (profile + KYC details). Where they live and for how long
// is tracked separately in "stays" (see modules/stays), so history is never lost.

const tenantFields = {
  name: z.string().trim().min(2),
  phone: z.string().trim().min(10).max(15),
  email: z.string().trim().toLowerCase().email().optional(),
  gender: z.nativeEnum(Gender).optional(),
  idProofType: z.string().trim().optional(), // Aadhaar, PAN, Passport...
  idProofNumber: z.string().trim().optional(),
  emergencyName: z.string().trim().optional(),
  emergencyPhone: z.string().trim().optional(),
};

const createTenantSchema = z.object(tenantFields);
const updateTenantSchema = z.object(tenantFields).partial();

// What we load to show where a tenant lives.
const stayWithBed = {
  bed: { select: { id: true, label: true, room: { select: { id: true, roomNumber: true, propertyId: true } } } },
} satisfies Prisma.StayInclude;

export const tenantsRouter = Router();
tenantsRouter.use(authenticate);

// POST /api/tenants  (owner + staff) -> create a tenant profile (not checked in yet)
tenantsRouter.post(
  "/",
  requireRole(Role.OWNER, Role.STAFF),
  validateBody(createTenantSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);

    const duplicate = await prisma.tenant.findFirst({
      where: { organizationId, phone: req.body.phone },
    });
    if (duplicate) {
      throw HttpError.conflict(`A tenant with this phone number already exists (${duplicate.name})`);
    }

    const tenant = await prisma.tenant.create({ data: { ...req.body, organizationId } });
    res.status(201).json({ tenant });
  })
);

// GET /api/tenants?status=ACTIVE&search=ravi  (owner + staff)
tenantsRouter.get(
  "/",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    const where: Prisma.TenantWhereInput = { organizationId: orgIdOf(req) };

    if (typeof req.query.status === "string") {
      const parsed = z.nativeEnum(TenantStatus).safeParse(req.query.status.toUpperCase());
      if (!parsed.success) throw HttpError.badRequest("Invalid status");
      where.status = parsed.data;
    }

    if (typeof req.query.search === "string" && req.query.search.trim()) {
      const term = req.query.search.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { phone: { contains: term } },
      ];
    }

    const tenants = await prisma.tenant.findMany({
      where,
      orderBy: { name: "asc" },
      include: {
        // Only the current stay (the one without a check-out date).
        stays: { where: { checkOutDate: null }, include: stayWithBed },
      },
    });

    res.json({
      tenants: tenants.map(({ stays, ...tenant }) => ({ ...tenant, currentStay: stays[0] ?? null })),
    });
  })
);

// GET /api/tenants/:id  (owner + staff) -> profile, current stay and full stay history
tenantsRouter.get(
  "/:id",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findFirst({
      where: { id: req.params.id, organizationId: orgIdOf(req) },
      include: { stays: { orderBy: { checkInDate: "desc" }, include: stayWithBed } },
    });
    if (!tenant) throw HttpError.notFound("Tenant not found");

    const { stays, ...profile } = tenant;
    res.json({
      tenant: { ...profile, currentStay: stays.find((s) => s.checkOutDate === null) ?? null, stays },
    });
  })
);

// PATCH /api/tenants/:id  (owner + staff)
tenantsRouter.patch(
  "/:id",
  requireRole(Role.OWNER, Role.STAFF),
  validateBody(updateTenantSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const existing = await prisma.tenant.findFirst({ where: { id: req.params.id, organizationId } });
    if (!existing) throw HttpError.notFound("Tenant not found");

    const tenant = await prisma.tenant.update({ where: { id: existing.id }, data: req.body });
    res.json({ tenant });
  })
);

// ---------------------------------------------------------------------------
// Tenant login accounts. The owner creates a login for a tenant so the tenant
// can open the app and see their own bills. Tenants then log in with the normal
// POST /api/auth/login and use the /api/me endpoints.
// ---------------------------------------------------------------------------

const accountSchema = z.object({
  // Falls back to the email on the tenant's profile.
  email: z.string().trim().toLowerCase().email().optional(),
  // If left out, a random temporary password is generated and returned once.
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
});

// POST /api/tenants/:id/account  (owner) -> create the tenant's login
tenantsRouter.post(
  "/:id/account",
  requireRole(Role.OWNER),
  validateBody(accountSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const input = req.body as z.infer<typeof accountSchema>;

    const tenant = await prisma.tenant.findFirst({ where: { id: req.params.id, organizationId } });
    if (!tenant) throw HttpError.notFound("Tenant not found");
    if (tenant.userId) throw HttpError.conflict("This tenant already has a login. Use reset-password instead.");

    const email = input.email ?? tenant.email;
    if (!email) {
      throw HttpError.badRequest('An email is needed. Send {"email": "..."} or add one to the tenant profile.');
    }
    const taken = await prisma.user.findUnique({ where: { email } });
    if (taken) throw HttpError.conflict("This email is already used by another account");

    const generated = input.password ? null : makeTemporaryPassword();
    const passwordHash = await bcrypt.hash(input.password ?? generated!, 12);

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          organizationId,
          name: tenant.name,
          email,
          phone: tenant.phone,
          passwordHash,
          role: Role.TENANT,
        },
        select: { id: true, email: true, role: true },
      });
      await tx.tenant.update({ where: { id: tenant.id }, data: { userId: created.id, email: tenant.email ?? email } });
      return created;
    });

    // A generated password is shown only now. Give it to the tenant and ask them to change it.
    res.status(201).json({ user, ...(generated ? { temporaryPassword: generated } : {}) });
  })
);

// POST /api/tenants/:id/account/reset-password  (owner) -> tenant forgot their password
tenantsRouter.post(
  "/:id/account/reset-password",
  requireRole(Role.OWNER),
  validateBody(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const input = req.body as z.infer<typeof resetPasswordSchema>;

    const tenant = await prisma.tenant.findFirst({ where: { id: req.params.id, organizationId } });
    if (!tenant) throw HttpError.notFound("Tenant not found");
    if (!tenant.userId) throw HttpError.conflict("This tenant does not have a login yet");

    const generated = input.password ? null : makeTemporaryPassword();
    const passwordHash = await bcrypt.hash(input.password ?? generated!, 12);
    await prisma.user.update({ where: { id: tenant.userId }, data: { passwordHash } });

    res.json({ message: "Password updated", ...(generated ? { temporaryPassword: generated } : {}) });
  })
);
