import * as cron from "node-cron";
import { env } from "../config/env";
import { runDailyAutomation } from "../modules/automation/automation.service";

// Starts the daily job inside the server process, using the India time zone.
// Default: every day at 9:00 AM (set SCHEDULER_CRON in .env to change, SCHEDULER_ENABLED=false to stop).
//
// Note: if you ever run several copies of the server at once, each copy would run the job.
// The job is safe to repeat (bills are never created twice, and emails are not re-sent),
// but turn the scheduler off on all but one copy to avoid wasted work.
export function startScheduler() {
  if (!env.SCHEDULER_ENABLED) {
    console.log("Scheduler is turned off (SCHEDULER_ENABLED=false)");
    return;
  }
  if (!cron.validate(env.SCHEDULER_CRON)) {
    console.error(`Scheduler not started: "${env.SCHEDULER_CRON}" is not a valid schedule`);
    return;
  }

  cron.schedule(
    env.SCHEDULER_CRON,
    () => {
      runDailyAutomation().catch((err) => console.error("[automation] Daily run failed:", err));
    },
    { timezone: "Asia/Kolkata" }
  );
  console.log(`Scheduler running: "${env.SCHEDULER_CRON}" (India time)`);
}
