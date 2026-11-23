import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { makeTemporaryPassword } from "../../utils/password";
import { validateBody } from "../../middleware/validate";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";

// Staff are managers or caretakers who work inside ONE PG business. They can record payments,
// check tenants in and out, and view data, but they cannot create rooms, bills or accounts,
// cancel bills, or change settings. Only the owner manages staff.

const createStaffSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().min(10).max(15).optional(),
  // If left out, a random temporary password is generated and returned once.
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
});

const updateStaffSchema = z
  .object({
    name: z.string().trim().min(2),
    phone: z.string().trim().min(10).max(15),
    // false = the staff member can no longer log in (their existing token stops working immediately)
    isActive: z.boolean(),
  })
  .partial();

const resetPasswordSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
});

const staffSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

// Only STAFF users of this organization. Never the owner, tenants or other businesses.
async function findStaff(id: string, organizationId: string) {
  const staff = await prisma.user.findFirst({ where: { id, organizationId, role: Role.STAFF } });
  if (!staff) throw HttpError.notFound("Staff member not found");
  return staff;
}

export const staffRouter = Router();
staffRouter.use(authenticate);
staffRouter.use(requireRole(Role.OWNER));

// POST /api/staff  -> create a staff login
staffRouter.post(
  "/",
  validateBody(createStaffSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const input = req.body as z.infer<typeof createStaffSchema>;

    const taken = await prisma.user.findUnique({ where: { email: input.email } });
    if (taken) throw HttpError.conflict("This email is already used by another account");

    const generated = input.password ? null : makeTemporaryPassword();
    const passwordHash = await bcrypt.hash(input.password ?? generated!, 12);

    const staff = await prisma.user.create({
      data: {
        organizationId,
        name: input.name,
        email: input.email,
        phone: input.phone,
        passwordHash,
        role: Role.STAFF,
      },
      select: staffSelect,
    });

    // A generated password is shown only now. Give it to the staff member and ask them to change it.
    res.status(201).json({ staff, ...(generated ? { temporaryPassword: generated } : {}) });
  })
);

// GET /api/staff  -> all staff of this PG business
staffRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const staff = await prisma.user.findMany({
      where: { organizationId: orgIdOf(req), role: Role.STAFF },
      select: staffSelect,
      orderBy: { name: "asc" },
    });
    res.json({ staff });
  })
);

// PATCH /api/staff/:id  -> change name or phone, or deactivate / reactivate
staffRouter.patch(
  "/:id",
  validateBody(updateStaffSchema),
  asyncHandler(async (req, res) => {
    const existing = await findStaff(req.params.id, orgIdOf(req));
    const staff = await prisma.user.update({
      where: { id: existing.id },
      data: req.body,
      select: staffSelect,
    });
    res.json({ staff });
  })
);

// POST /api/staff/:id/reset-password  -> staff forgot their password
staffRouter.post(
  "/:id/reset-password",
  validateBody(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as z.infer<typeof resetPasswordSchema>;
    const existing = await findStaff(req.params.id, orgIdOf(req));

    const generated = input.password ? null : makeTemporaryPassword();
    const passwordHash = await bcrypt.hash(input.password ?? generated!, 12);
    await prisma.user.update({ where: { id: existing.id }, data: { passwordHash } });

    res.json({ message: "Password updated", ...(generated ? { temporaryPassword: generated } : {}) });
  })
);
