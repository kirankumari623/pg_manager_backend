import { NextFunction, Request, Response } from "express";
import { Role } from "@prisma/client";
import { HttpError } from "../lib/httpError";
import { prisma } from "../lib/prisma";
import { AuthPayload, verifyToken } from "../lib/jwt";
import { ensureSubscription, subscriptionState } from "../lib/subscription";

// Even when an owner's subscription has ended, these stay open so they can log in, see their plan and pay.
const OPEN_WHEN_EXPIRED = ["/api/auth", "/api/subscription"];
const READ_ONLY_METHODS = ["GET", "HEAD", "OPTIONS"];

// Requires a valid "Authorization: Bearer <token>" header.
// Besides checking the token itself, it confirms the account still exists and is active,
// so tokens of deleted or deactivated accounts stop working immediately. The role and
// organization are taken from the database, so changes to them apply right away.
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(HttpError.unauthorized("Missing or malformed Authorization header"));
  }

  let payload: AuthPayload;
  try {
    payload = verifyToken(header.slice("Bearer ".length));
  } catch {
    return next(HttpError.unauthorized("Invalid or expired token"));
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        role: true,
        organizationId: true,
        isActive: true,
        organization: { select: { isActive: true, subscription: { select: { trialEndsOn: true, paidUntil: true } } } },
      },
    });
    if (!user) return next(HttpError.unauthorized("This account no longer exists. Please log in again."));
    if (!user.isActive || (user.organization && !user.organization.isActive)) {
      return next(HttpError.forbidden("This account has been deactivated"));
    }

    // When the owner's free trial and payments have run out, owners and staff can still LOOK at everything
    // but cannot change anything (answer 402 "payment required"). Tenants are always free and never affected.
    const isOwnerSide = user.role === Role.OWNER || user.role === Role.STAFF;
    const isChange = !READ_ONLY_METHODS.includes(req.method);
    const isOpenArea = OPEN_WHEN_EXPIRED.some((prefix) => req.baseUrl.startsWith(prefix));
    if (isOwnerSide && isChange && !isOpenArea && user.organizationId) {
      const subscription = user.organization?.subscription ?? (await ensureSubscription(user.organizationId));
      if (!subscriptionState(subscription).canMakeChanges) {
        return next(
          new HttpError(402, "Your free trial has ended. Please subscribe to keep adding or changing data. You can still view everything.")
        );
      }
    }

    req.auth = { userId: user.id, role: user.role, organizationId: user.organizationId };
    next();
  } catch (err) {
    next(err);
  }
}

// Allows only the listed roles. Use after `authenticate`.
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(HttpError.unauthorized());
    if (!roles.includes(req.auth.role)) {
      return next(HttpError.forbidden("You do not have permission to do this"));
    }
    next();
  };
}

// Returns the organizationId of the logged-in user, or throws.
// EVERY database query for business data must filter by this value.
export function orgIdOf(req: Request): string {
  const orgId = req.auth?.organizationId;
  if (!orgId) throw HttpError.forbidden("This action requires an organization account");
  return orgId;
}
