import { Router } from "express";
import { z } from "zod";
import { PaymentMethod, Prisma, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate, requireRole } from "../../middleware/auth";
import { startOfTodayIST } from "../../utils/dates";
import { addDays, describeSubscription, ensureSubscription, latestDate, subscriptionState } from "../../lib/subscription";

// For YOU, the product owner (PLATFORM_ADMIN account made with `npm run seed`).
// Owners cannot reach any of this.
export const adminRouter = Router();
adminRouter.use(authenticate, requireRole(Role.PLATFORM_ADMIN));

const paymentSchema = z.object({
  amount: z.coerce.number().positive().max(1_000_000),
  months: z.coerce.number().int().min(1).max(24).default(1),
  method: z.nativeEnum(PaymentMethod).default(PaymentMethod.UPI),
  reference: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(300).optional(),
});

const planSchema = z
  .object({
    extendTrialDays: z.coerce.number().int().min(1).max(365),
    priceMonthly: z.coerce.number().positive().max(100000),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Send extendTrialDays and/or priceMonthly");

const organizationSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  isActive: true,
  createdAt: true,
  subscription: true,
  users: { where: { role: Role.OWNER }, select: { name: true, email: true, phone: true }, take: 1 },
  _count: { select: { properties: true, tenants: true } },
} satisfies Prisma.OrganizationSelect;

// GET /api/admin/organizations?status=EXPIRED&search=sunrise
// Every PG business on your platform and where each stands (trial / paid / ended).
adminRouter.get(
  "/organizations",
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
    if (status && !["TRIALING", "ACTIVE", "EXPIRED"].includes(status)) {
      throw HttpError.badRequest("status must be TRIALING, ACTIVE or EXPIRED");
    }
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

    const found = await prisma.organization.findMany({
      where: search ? { name: { contains: search, mode: "insensitive" } } : {},
      select: organizationSelect,
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    const rows = [];
    for (const org of found) {
      // Businesses from before subscriptions existed get their free trial the first time they show up here.
      const sub = org.subscription ?? (await ensureSubscription(org.id));
      const { users, subscription: _omit, _count, ...rest } = org;
      rows.push({ ...rest, owner: users[0] ?? null, properties: _count.properties, tenants: _count.tenants, subscription: describeSubscription(sub) });
    }

    const count = (s: string) => rows.filter((r) => r.subscription.status === s).length;
    res.json({
      organizations: status ? rows.filter((r) => r.subscription.status === status) : rows,
      counts: { total: rows.length, trialing: count("TRIALING"), active: count("ACTIVE"), expired: count("EXPIRED") },
    });
  })
);

// GET /api/admin/organizations/:id -> one business with its payment history
adminRouter.get(
  "/organizations/:id",
  asyncHandler(async (req, res) => {
    const org = await prisma.organization.findUnique({ where: { id: req.params.id }, select: organizationSelect });
    if (!org) throw HttpError.notFound("Organization not found");

    const sub = org.subscription ?? (await ensureSubscription(org.id));
    const payments = await prisma.subscriptionPayment.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const { users, subscription: _omit, _count, ...rest } = org;
    res.json({
      organization: { ...rest, owner: users[0] ?? null, properties: _count.properties, tenants: _count.tenants },
      subscription: describeSubscription(sub),
      payments,
    });
  })
);

// POST /api/admin/organizations/:id/subscription/payments
//   { "amount": 300, "months": 1, "method": "UPI", "reference": "UPI123456" }
// Records money you received from an owner and extends their plan. The new period starts the day after
// whatever is already covered (the free trial or an earlier payment), so paying early loses nothing.
// One "month" is 30 days.
adminRouter.post(
  "/organizations/:id/subscription/payments",
  validateBody(paymentSchema),
  asyncHandler(async (req, res) => {
    const organizationId = req.params.id;
    const body = req.body as z.infer<typeof paymentSchema>;

    const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!org) throw HttpError.notFound("Organization not found");

    // The same bank / UPI reference cannot be recorded twice for one business.
    if (body.reference) {
      const duplicate = await prisma.subscriptionPayment.findFirst({
        where: { organizationId, reference: body.reference },
        select: { id: true },
      });
      if (duplicate) throw HttpError.conflict("A payment with this reference is already recorded");
    }

    const subscription = await ensureSubscription(organizationId);
    const yesterday = addDays(startOfTodayIST(), -1);
    const lastCoveredDay = latestDate(subscription.trialEndsOn, subscription.paidUntil ?? yesterday, yesterday);
    const coversFrom = addDays(lastCoveredDay, 1);
    const coversUntil = addDays(lastCoveredDay, 30 * body.months);

    const [payment, updated] = await prisma.$transaction([
      prisma.subscriptionPayment.create({
        data: { organizationId, ...body, coversFrom, coversUntil, recordedById: req.auth!.userId },
      }),
      prisma.subscription.update({ where: { organizationId }, data: { paidUntil: coversUntil } }),
    ]);

    res.status(201).json({ payment, subscription: describeSubscription(updated) });
  })
);

// PATCH /api/admin/organizations/:id/subscription  { "extendTrialDays": 15 } or { "priceMonthly": 199 }
// Goodwill: give an owner more free days, or a different monthly price.
adminRouter.patch(
  "/organizations/:id/subscription",
  validateBody(planSchema),
  asyncHandler(async (req, res) => {
    const organizationId = req.params.id;
    const body = req.body as z.infer<typeof planSchema>;

    const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!org) throw HttpError.notFound("Organization not found");

    const subscription = await ensureSubscription(organizationId);
    const data: Prisma.SubscriptionUpdateInput = {};
    if (body.extendTrialDays) {
      // Counted from today if the trial already ended, otherwise from its current end.
      data.trialEndsOn = addDays(latestDate(subscription.trialEndsOn, startOfTodayIST()), body.extendTrialDays);
    }
    if (body.priceMonthly) data.priceMonthly = body.priceMonthly;

    const updated = await prisma.subscription.update({ where: { organizationId }, data });
    res.json({ subscription: describeSubscription(updated), status: subscriptionState(updated).status });
  })
);
