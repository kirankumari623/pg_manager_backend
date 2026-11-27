import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "./prisma";
import { startOfTodayIST } from "../utils/dates";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SubscriptionStatus = "TRIALING" | "ACTIVE" | "EXPIRED";

export interface SubscriptionDates {
  trialEndsOn: Date;
  paidUntil: Date | null;
}

// Works out where an owner stands today, from the two dates.
//   ACTIVE   = a payment covers today
//   TRIALING = still inside the free trial
//   EXPIRED  = neither; the owner can look at their data but not change it
export function subscriptionState(sub: SubscriptionDates, today: Date = startOfTodayIST()) {
  const paid = sub.paidUntil !== null && sub.paidUntil >= today;
  const status: SubscriptionStatus = paid ? "ACTIVE" : sub.trialEndsOn >= today ? "TRIALING" : "EXPIRED";

  // The last day the current status lasts (0 days left = today is the last day).
  const endsOn = paid ? sub.paidUntil! : sub.trialEndsOn;
  const daysLeft = status === "EXPIRED" ? 0 : Math.round((endsOn.getTime() - today.getTime()) / DAY_MS);

  return { status, endsOn, daysLeft, canMakeChanges: status !== "EXPIRED" };
}

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

// The trial for an account created today.
export function newTrialEndDate() {
  return addDays(startOfTodayIST(), env.TRIAL_DAYS);
}

// Accounts created before subscriptions existed have no row yet. They get one the first time it is
// needed, with a fresh free trial starting today. Safe to call many times.
export async function ensureSubscription(organizationId: string) {
  return prisma.subscription.upsert({
    where: { organizationId },
    update: {},
    create: { organizationId, trialEndsOn: newTrialEndDate(), priceMonthly: new Prisma.Decimal(env.SUBSCRIPTION_PRICE) },
  });
}

export const latestDate = (...dates: Date[]) => new Date(Math.max(...dates.map((d) => d.getTime())));

// What the apps and the admin screens show about a plan.
export function describeSubscription(sub: SubscriptionDates & { priceMonthly: Prisma.Decimal }) {
  return {
    ...subscriptionState(sub),
    trialEndsOn: sub.trialEndsOn,
    paidUntil: sub.paidUntil,
    priceMonthly: sub.priceMonthly,
  };
}
