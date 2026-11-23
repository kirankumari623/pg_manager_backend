import { BillStatus, NotificationStatus, NotificationType, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { emailProvider } from "../../lib/email";
import { billEmail, receiptEmail } from "../../lib/emailTemplates";
import { startOfTodayIST } from "../../utils/dates";

const OPEN_STATUSES: BillStatus[] = [BillStatus.UNPAID, BillStatus.PARTIAL];

export interface SendResult {
  status: "SENT" | "FAILED" | "SKIPPED";
  reason?: string;
}

// What we load so a bill can be turned into an email.
export const billEmailInclude = {
  tenant: { select: { id: true, name: true, email: true } },
  organization: { select: { name: true, phone: true, email: true } },
} satisfies Prisma.BillInclude;

export type BillForEmail = Prisma.BillGetPayload<{ include: typeof billEmailInclude }>;

export const paymentEmailInclude = {
  tenant: { select: { id: true, name: true, email: true } },
  organization: { select: { name: true, phone: true, email: true } },
  bill: { select: { type: true, description: true, amount: true, paidAmount: true } },
} satisfies Prisma.PaymentInclude;

export type PaymentForEmail = Prisma.PaymentGetPayload<{ include: typeof paymentEmailInclude }>;

// Sends one email and records what happened in the Notification log, whether it worked or not.
async function deliverEmail(args: {
  organizationId: string;
  tenantId: string;
  billId?: string;
  paymentId?: string;
  type: NotificationType;
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<SendResult> {
  let status: NotificationStatus = NotificationStatus.SENT;
  let error: string | undefined;

  try {
    await emailProvider.send({ to: args.to, subject: args.subject, text: args.text, html: args.html });
  } catch (err) {
    status = NotificationStatus.FAILED;
    error = err instanceof Error ? err.message : String(err);
  }

  try {
    await prisma.notification.create({
      data: {
        organizationId: args.organizationId,
        tenantId: args.tenantId,
        billId: args.billId,
        paymentId: args.paymentId,
        type: args.type,
        toAddress: args.to,
        subject: args.subject,
        body: args.text,
        status,
        error,
      },
    });
  } catch (logError) {
    // The email was already attempted; a logging problem must not hide that.
    console.error("Could not save notification log:", logError);
  }

  return status === NotificationStatus.SENT ? { status: "SENT" } : { status: "FAILED", reason: error };
}

export async function sendBillEmail(bill: BillForEmail, kind: "BILL" | "REMINDER"): Promise<SendResult> {
  if (bill.status === BillStatus.PAID) return { status: "SKIPPED", reason: "Bill is already paid" };
  if (bill.status === BillStatus.CANCELLED) return { status: "SKIPPED", reason: "Bill is cancelled" };
  if (!bill.tenant.email) return { status: "SKIPPED", reason: "Tenant has no email address" };

  // The tenant's other unpaid charges that are overdue or due by the end of the month this bill
  // falls in, so the email shows the whole picture (rent + electricity + extra charges).
  // Charges due in later months are left out.
  const today = startOfTodayIST();
  const reference = bill.dueDate > today ? bill.dueDate : today;
  const endOfMonth = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 1));
  const otherCharges = await prisma.bill.findMany({
    where: {
      organizationId: bill.organizationId,
      tenantId: bill.tenant.id,
      id: { not: bill.id },
      status: { in: OPEN_STATUSES },
      dueDate: { lt: endOfMonth },
    },
    orderBy: { dueDate: "asc" },
    select: { type: true, description: true, amount: true, paidAmount: true, dueDate: true },
  });

  const mail = billEmail({ tenantName: bill.tenant.name, pg: bill.organization, bill, kind, otherCharges });
  return deliverEmail({
    organizationId: bill.organizationId,
    tenantId: bill.tenant.id,
    billId: bill.id,
    type: kind === "REMINDER" ? NotificationType.REMINDER : NotificationType.BILL,
    to: bill.tenant.email,
    ...mail,
  });
}

export async function sendReceiptEmail(payment: PaymentForEmail): Promise<SendResult> {
  if (!payment.tenant.email) return { status: "SKIPPED", reason: "Tenant has no email address" };

  const mail = receiptEmail({
    tenantName: payment.tenant.name,
    pg: payment.organization,
    receiptNumber: payment.receiptNumber,
    amount: payment.amount,
    method: payment.method,
    reference: payment.reference,
    paidAt: payment.paidAt,
    bill: payment.bill,
    balanceNow: payment.bill.amount.minus(payment.bill.paidAmount),
  });
  return deliverEmail({
    organizationId: payment.organizationId,
    tenantId: payment.tenant.id,
    billId: payment.billId,
    paymentId: payment.id,
    type: NotificationType.RECEIPT,
    to: payment.tenant.email,
    ...mail,
  });
}

// ---------------------------------------------------------------------------
// Sending to many tenants at once. Used by the bulk endpoint and by the daily automation.
// ---------------------------------------------------------------------------

export interface BulkItem {
  billId: string;
  tenantName: string;
  status: SendResult["status"];
  reason?: string;
}

export interface BulkSummary {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  results: BulkItem[];
}

// Emails each bill one at a time, so a problem with one never stops the others.
// `skip` maps a bill id to the reason it should not be emailed.
async function sendEach(bills: BillForEmail[], kind: "BILL" | "REMINDER", skip: Map<string, string>): Promise<BulkSummary> {
  const results: BulkItem[] = [];
  for (const bill of bills) {
    const skipReason = skip.get(bill.id);
    const result: SendResult = skipReason
      ? { status: "SKIPPED", reason: skipReason }
      : await sendBillEmail(bill, kind);
    results.push({ billId: bill.id, tenantName: bill.tenant.name, ...result });
  }
  const count = (status: SendResult["status"]) => results.filter((r) => r.status === status).length;
  return { total: results.length, sent: count("SENT"), failed: count("FAILED"), skipped: count("SKIPPED"), results };
}

//   { kind: "BILL", month: "2026-11" }  -> unpaid rent bills of that month
//   { kind: "REMINDER" }                -> every overdue bill
// A bill that was already emailed is not emailed again unless resend is true.
export async function sendBulkBillEmails(
  organizationId: string,
  input: { kind: "BILL" | "REMINDER"; month?: string; tenantId?: string; resend: boolean }
): Promise<BulkSummary> {
  const where: Prisma.BillWhereInput = { organizationId, status: { in: OPEN_STATUSES } };
  if (input.tenantId) where.tenantId = input.tenantId;

  if (input.kind === "BILL") {
    const [year, month] = input.month!.split("-").map(Number);
    where.periodMonth = new Date(Date.UTC(year, month - 1, 1));
  } else {
    where.dueDate = { lt: startOfTodayIST() };
  }

  const bills = await prisma.bill.findMany({
    where,
    include: billEmailInclude,
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    take: 200,
  });

  const skip = new Map<string, string>();
  if (input.kind === "BILL" && !input.resend && bills.length) {
    const sent = await prisma.notification.findMany({
      where: {
        organizationId,
        type: NotificationType.BILL,
        status: NotificationStatus.SENT,
        billId: { in: bills.map((b) => b.id) },
      },
      select: { billId: true },
    });
    for (const n of sent) skip.set(n.billId!, "Already emailed (send with resend: true to email again)");
  }

  return sendEach(bills, input.kind, skip);
}

// Reminders for overdue bills, but at most one per bill every `everyDays` days,
// so tenants are not emailed daily. Used by the automation.
export async function sendOverdueReminders(organizationId: string, everyDays: number): Promise<BulkSummary> {
  const bills = await prisma.bill.findMany({
    where: { organizationId, status: { in: OPEN_STATUSES }, dueDate: { lt: startOfTodayIST() } },
    include: billEmailInclude,
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    take: 200,
  });

  const skip = new Map<string, string>();
  if (bills.length) {
    const cutoff = new Date(Date.now() - everyDays * 24 * 60 * 60 * 1000);
    const recent = await prisma.notification.findMany({
      where: {
        organizationId,
        type: NotificationType.REMINDER,
        status: NotificationStatus.SENT,
        createdAt: { gte: cutoff },
        billId: { in: bills.map((b) => b.id) },
      },
      select: { billId: true },
    });
    for (const n of recent) skip.set(n.billId!, `A reminder was already sent in the last ${everyDays} days`);
  }

  return sendEach(bills, "REMINDER", skip);
}
