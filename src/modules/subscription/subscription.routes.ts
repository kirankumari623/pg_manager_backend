import { Router } from "express";
import { Role } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/asyncHandler";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";
import { describeSubscription, ensureSubscription } from "../../lib/subscription";

export const subscriptionRouter = Router();
subscriptionRouter.use(authenticate, requireRole(Role.OWNER, Role.STAFF));

// GET /api/subscription
// Where the PG stands: free trial, paid, or ended. Works even after the plan has ended,
// so an owner can always see what to do. The payment history is for the owner only.
subscriptionRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const subscription = await ensureSubscription(organizationId);

    const payments =
      req.auth!.role === Role.OWNER
        ? await prisma.subscriptionPayment.findMany({
            where: { organizationId },
            orderBy: { createdAt: "desc" },
            take: 24,
            select: { id: true, amount: true, months: true, method: true, reference: true, coversFrom: true, coversUntil: true, createdAt: true },
          })
        : undefined;

    res.json({
      subscription: describeSubscription(subscription),
      // Online payment (Razorpay) is not connected yet. Until it is, the owner follows these instructions
      // and the platform admin records the payment.
      onlinePaymentAvailable: false,
      paymentInstructions: env.PAYMENT_INSTRUCTIONS ?? null,
      payments,
    });
  })
);
