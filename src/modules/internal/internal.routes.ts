import { Router } from "express";
import { timingSafeEqual } from "crypto";
import { env } from "../../config/env";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { runDailyAutomation } from "../automation/automation.service";

export const internalRouter = Router();

function secretMatches(given: string | undefined, expected: string) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// POST /api/internal/run-daily
// For free hosts that go to sleep (so the built-in 9 AM timer cannot be trusted).
// An outside timer (for example cron-job.org) calls this every morning with the header
//   x-cron-secret: <your CRON_SECRET>
// The job is safe to run more than once a day: bills are never duplicated and emails are not re-sent.
internalRouter.post(
  "/run-daily",
  asyncHandler(async (req, res) => {
    if (!env.CRON_SECRET) throw HttpError.notFound(); // switched off unless CRON_SECRET is set
    if (!secretMatches(req.header("x-cron-secret"), env.CRON_SECRET)) {
      throw HttpError.unauthorized("Invalid cron secret");
    }

    // Answer straight away (outside timers give up after ~30 seconds), and keep working in the background.
    res.status(202).json({ message: "Daily automation started" });
    runDailyAutomation().catch((err) => console.error("[automation] Daily run failed:", err));
  })
);
