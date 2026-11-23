import { Router } from "express";
import { z } from "zod";
import { NotificationStatus, NotificationType, Prisma, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";
import { startOfTodayIST } from "../../utils/dates";
import {
  billEmailInclude,
  paymentEmailInclude,
  sendBillEmail,
  sendBulkBillEmails,
  sendReceiptEmail,
} from "./notifications.service";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use the format YYYY-MM, e.g. 2026-11");

const sendOneSchema = z.object({
  // BILL = "here is your bill", REMINDER = "this is overdue".
  // If left out, overdue bills get a REMINDER and the rest get a BILL.
  kind: z.enum(["BILL", "REMINDER"]).optional(),
});

const sendBulkSchema = z
  .object({
    kind: z.enum(["BILL", "REMINDER"]),
    month: monthSchema.optional(),
    tenantId: z.string().min(1).optional(),
    // By default a bill that was already emailed is not emailed again. Set true to force it.
    resend: z.boolean().default(false),
  })
  .refine((v) => v.kind !== "BILL" || !!v.month, { message: "month is required when kind is BILL", path: ["month"] });

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);
notificationsRouter.use(requireRole(Role.OWNER, Role.STAFF));

// POST /api/notifications/bills  -> email many tenants at once
//   { "kind": "BILL", "month": "2026-11" }   rent bills for a month
//   { "kind": "REMINDER" }                    everyone with an overdue bill
notificationsRouter.post(
  "/bills",
  validateBody(sendBulkSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const input = req.body as z.infer<typeof sendBulkSchema>;

    res.json(await sendBulkBillEmails(organizationId, input));
  })
);

// POST /api/notifications/bills/:billId  -> email one bill (or an overdue reminder) to its tenant
notificationsRouter.post(
  "/bills/:billId",
  validateBody(sendOneSchema),
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const { kind } = req.body as z.infer<typeof sendOneSchema>;

    const bill = await prisma.bill.findFirst({
      where: { id: req.params.billId, organizationId },
      include: billEmailInclude,
    });
    if (!bill) throw HttpError.notFound("Bill not found");

    const chosenKind = kind ?? (bill.dueDate < startOfTodayIST() ? "REMINDER" : "BILL");
    const result = await sendBillEmail(bill, chosenKind);

    if (result.status === "SKIPPED") throw HttpError.badRequest(`Email not sent: ${result.reason}`);
    if (result.status === "FAILED") throw new HttpError(502, `The email could not be sent: ${result.reason}`);

    res.json({ result: { ...result, kind: chosenKind, to: bill.tenant.email } });
  })
);

// POST /api/notifications/payments/:paymentId/receipt  -> email a receipt to the tenant
notificationsRouter.post(
  "/payments/:paymentId/receipt",
  asyncHandler(async (req, res) => {
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.paymentId, organizationId: orgIdOf(req) },
      include: paymentEmailInclude,
    });
    if (!payment) throw HttpError.notFound("Payment not found");

    const result = await sendReceiptEmail(payment);

    if (result.status === "SKIPPED") throw HttpError.badRequest(`Email not sent: ${result.reason}`);
    if (result.status === "FAILED") throw new HttpError(502, `The email could not be sent: ${result.reason}`);

    res.json({ result: { ...result, to: payment.tenant.email } });
  })
);

// GET /api/notifications?status=FAILED&type=BILL&tenantId=...&billId=...  -> what was sent, and what failed
notificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const where: Prisma.NotificationWhereInput = { organizationId: orgIdOf(req) };

    if (typeof req.query.status === "string") {
      const parsed = z.nativeEnum(NotificationStatus).safeParse(req.query.status.toUpperCase());
      if (!parsed.success) throw HttpError.badRequest("Invalid status");
      where.status = parsed.data;
    }
    if (typeof req.query.type === "string") {
      const parsed = z.nativeEnum(NotificationType).safeParse(req.query.type.toUpperCase());
      if (!parsed.success) throw HttpError.badRequest("Invalid type");
      where.type = parsed.data;
    }
    if (typeof req.query.tenantId === "string") where.tenantId = req.query.tenantId;
    if (typeof req.query.billId === "string") where.billId = req.query.billId;

    const notifications = await prisma.notification.findMany({
      where,
      include: { tenant: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ notifications });
  })
);
