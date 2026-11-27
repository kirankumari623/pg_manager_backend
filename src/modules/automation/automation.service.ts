import { prisma } from "../../lib/prisma";
import { ensureSubscription, subscriptionState } from "../../lib/subscription";
import { startOfTodayIST } from "../../utils/dates";
import { generateRentBills } from "../bills/bills.service";
import { BulkSummary, sendBulkBillEmails, sendOverdueReminders } from "../notifications/notifications.service";

// What the automation does for one PG business, following that owner's settings:
//   1. On the 1st of the month: create that month's rent bills (and email them if autoSendBills is on).
//   2. Every day: email reminders for overdue bills (at most one per bill every reminderEveryDays days).
// Nothing happens unless the owner switched the setting on.

export interface AutomationSummary {
  date: string;
  rent: Awaited<ReturnType<typeof generateRentBills>> | null;
  billEmails: BulkSummary | null;
  reminders: BulkSummary | null;
  notes: string[];
}

export async function runAutomationForOrganization(
  organizationId: string,
  options: { forceGenerate?: boolean } = {}
): Promise<AutomationSummary | null> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      isActive: true,
      autoRentEnabled: true,
      autoRentDueDay: true,
      autoSendBills: true,
      autoRemindersEnabled: true,
      reminderEveryDays: true,
    },
  });
  if (!org || !org.isActive) return null;

  // "Today" in India, as year / month / day.
  const today = startOfTodayIST();
  const month = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const isFirstOfMonth = today.getUTCDate() === 1;

  const summary: AutomationSummary = {
    date: today.toISOString().slice(0, 10),
    rent: null,
    billEmails: null,
    reminders: null,
    notes: [],
  };

  // No bills or emails for an owner whose free trial and payments have run out.
  const subscription = await ensureSubscription(organizationId);
  if (!subscriptionState(subscription).canMakeChanges) {
    summary.notes.push("Skipped: the subscription has ended. Automation resumes once the owner subscribes.");
    return summary;
  }

  if (org.autoRentEnabled) {
    if (isFirstOfMonth || options.forceGenerate) {
      summary.rent = await generateRentBills(organizationId, month, org.autoRentDueDay);
      if (org.autoSendBills) {
        // Already-emailed bills are skipped, so running this twice never double-sends.
        summary.billEmails = await sendBulkBillEmails(organizationId, { kind: "BILL", month, resend: false });
      }
    } else {
      summary.notes.push("Rent bills are created automatically on the 1st of each month. Today is not the 1st.");
    }
  } else {
    summary.notes.push("Automatic rent bills are switched off.");
  }

  if (org.autoRemindersEnabled) {
    summary.reminders = await sendOverdueReminders(organizationId, org.reminderEveryDays);
  } else {
    summary.notes.push("Automatic reminders are switched off.");
  }

  return summary;
}

// The daily job: runs the automation for every active business that has something switched on.
// One business failing never stops the others.
export async function runDailyAutomation() {
  const organizations = await prisma.organization.findMany({
    where: { isActive: true, OR: [{ autoRentEnabled: true }, { autoRemindersEnabled: true }] },
    select: { id: true, name: true },
  });

  console.log(`[automation] Running for ${organizations.length} business(es)...`);
  for (const org of organizations) {
    try {
      const summary = await runAutomationForOrganization(org.id);
      console.log(
        `[automation] ${org.name}: ` +
          `rent bills created=${summary?.rent?.created ?? "-"}, ` +
          `bill emails sent=${summary?.billEmails?.sent ?? "-"}, ` +
          `reminders sent=${summary?.reminders?.sent ?? "-"}`
      );
    } catch (err) {
      console.error(`[automation] ${org.name} failed:`, err);
    }
  }
}
