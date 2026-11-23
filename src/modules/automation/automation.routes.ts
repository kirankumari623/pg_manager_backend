import { Router } from "express";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";
import { runAutomationForOrganization } from "./automation.service";

const updateSettingsSchema = z
  .object({
    autoRentEnabled: z.boolean(),
    autoRentDueDay: z.coerce.number().int().min(1).max(28),
    autoSendBills: z.boolean(),
    autoRemindersEnabled: z.boolean(),
    reminderEveryDays: z.coerce.number().int().min(1).max(30),
  })
  .partial();

const runSchema = z.object({
  // Create this month's rent bills now, even if today is not the 1st. For testing, or if the 1st was missed.
  forceGenerate: z.boolean().default(false),
});

const settingsSelect = {
  autoRentEnabled: true,
  autoRentDueDay: true,
  autoSendBills: true,
  autoRemindersEnabled: true,
  reminderEveryDays: true,
} satisfies Prisma.OrganizationSelect;

export const automationRouter = Router();
automationRouter.use(authenticate);
automationRouter.use(requireRole(Role.OWNER));

// GET /api/automation/settings
automationRouter.get(
  "/settings",
  asyncHandler(async (req, res) => {
    const settings = await prisma.organization.findUnique({
      where: { id: orgIdOf(req) },
      select: settingsSelect,
    });
    res.json({ settings });
  })
);

// PATCH /api/automation/settings  -> switch the automation on or off and tune it
automationRouter.patch(
  "/settings",
  validateBody(updateSettingsSchema),
  asyncHandler(async (req, res) => {
    const settings = await prisma.organization.update({
      where: { id: orgIdOf(req) },
      data: req.body,
      select: settingsSelect,
    });
    res.json({ settings });
  })
);

// POST /api/automation/run  -> run today's automation for your business right now
// Does exactly what the daily job does for you, following your settings. Handy for testing.
automationRouter.post(
  "/run",
  validateBody(runSchema),
  asyncHandler(async (req, res) => {
    const { forceGenerate } = req.body as z.infer<typeof runSchema>;
    const summary = await runAutomationForOrganization(orgIdOf(req), { forceGenerate });
    if (!summary) throw HttpError.notFound("Business not found or inactive");
    res.json({ summary });
  })
);
