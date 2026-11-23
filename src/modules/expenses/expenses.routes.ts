import { Router } from "express";
import { z } from "zod";
import { ExpenseCategory, Prisma, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";
import { monthRange } from "../../utils/dates";

// A real calendar date written as 2026-11-13. Stored as a plain date (midnight UTC).
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must look like 2026-11-13")
  .refine((v) => !isNaN(new Date(`${v}T00:00:00.000Z`).getTime()) && new Date(`${v}T00:00:00.000Z`).toISOString().startsWith(v), "not a real date")
  .transform((v) => new Date(`${v}T00:00:00.000Z`));

const createSchema = z.object({
  category: z.nativeEnum(ExpenseCategory),
  amount: z.coerce.number().positive("amount must be more than 0").max(10_000_000),
  expenseDate: dateOnly,
  description: z.string().trim().max(300).optional(),
  paidTo: z.string().trim().max(120).optional(),
  propertyId: z.string().trim().min(1).optional(),
});

const updateSchema = createSchema.partial().extend({
  // null clears the building
  propertyId: z.string().trim().min(1).nullable().optional(),
});

async function assertPropertyInOrg(organizationId: string, propertyId: string | null | undefined) {
  if (!propertyId) return;
  const property = await prisma.property.findFirst({ where: { id: propertyId, organizationId }, select: { id: true } });
  if (!property) throw HttpError.badRequest("Property not found");
}

export const expensesRouter = Router();
expensesRouter.use(authenticate);

// GET /api/expenses?month=2026-11&category=FOOD&propertyId=...   (owner + staff)
expensesRouter.get(
  "/",
  requireRole(Role.OWNER, Role.STAFF),
  asyncHandler(async (req, res) => {
    const where: Prisma.ExpenseWhereInput = { organizationId: orgIdOf(req) };

    if (typeof req.query.month === "string") {
      const range = monthRange(req.query.month);
      if (!range) throw HttpError.badRequest("month must look like 2026-11");
      where.expenseDate = { gte: range.start, lt: range.end };
    }
    if (typeof req.query.category === "string") {
      const parsed = z.nativeEnum(ExpenseCategory).safeParse(req.query.category.toUpperCase());
      if (!parsed.success) throw HttpError.badRequest("Invalid category");
      where.category = parsed.data;
    }
    if (typeof req.query.propertyId === "string") where.propertyId = req.query.propertyId;

    const [expenses, byCategory] = await Promise.all([
      prisma.expense.findMany({
        where,
        include: { property: { select: { id: true, name: true } }, recordedBy: { select: { name: true } } },
        orderBy: [{ expenseDate: "desc" }, { createdAt: "desc" }],
        take: 500,
      }),
      // Totals cover everything that matches the filters, not just the 500 rows shown.
      prisma.expense.groupBy({ by: ["category"], where, _sum: { amount: true }, _count: { _all: true } }),
    ]);

    const zero = new Prisma.Decimal(0);
    const total = byCategory.reduce((sum, g) => sum.plus(g._sum.amount ?? zero), zero);
    res.json({
      expenses,
      total,
      byCategory: byCategory
        .map((g) => ({ category: g.category, amount: g._sum.amount ?? zero, count: g._count._all }))
        .sort((a, b) => b.amount.comparedTo(a.amount)),
    });
  })
);

// POST /api/expenses   (owner + staff)
expensesRouter.post(
  "/",
  requireRole(Role.OWNER, Role.STAFF),
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    await assertPropertyInOrg(organizationId, req.body.propertyId);

    const expense = await prisma.expense.create({
      data: { ...req.body, organizationId, recordedById: req.auth!.userId },
    });
    res.status(201).json({ expense });
  })
);

// PATCH /api/expenses/:id   (owner only)
expensesRouter.patch(
  "/:id",
  requireRole(Role.OWNER),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const existing = await prisma.expense.findFirst({ where: { id: req.params.id, organizationId }, select: { id: true } });
    if (!existing) throw HttpError.notFound("Expense not found");
    await assertPropertyInOrg(organizationId, req.body.propertyId);

    const expense = await prisma.expense.update({ where: { id: existing.id }, data: req.body });
    res.json({ expense });
  })
);

// DELETE /api/expenses/:id   (owner only)
expensesRouter.delete(
  "/:id",
  requireRole(Role.OWNER),
  asyncHandler(async (req, res) => {
    const result = await prisma.expense.deleteMany({ where: { id: req.params.id, organizationId: orgIdOf(req) } });
    if (result.count === 0) throw HttpError.notFound("Expense not found");
    res.json({ message: "Expense deleted" });
  })
);
