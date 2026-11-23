import { Prisma } from "@prisma/client";

// The wording of every email lives here, so you can change it in one place.

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatMoney(amount: Prisma.Decimal) {
  return `₹${amount.toNumber().toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

// Bill due dates are stored as plain dates (midnight UTC), so show them in UTC to avoid shifting a day.
export function formatDate(date: Date) {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Payment times are real moments, so show them in Indian time.
function formatDateTime(date: Date) {
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

export interface PgInfo {
  name: string;
  phone: string | null;
  email: string | null;
}

export interface BillInfo {
  type: string;
  description: string | null;
  amount: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  dueDate: Date;
}

const billLabel = (bill: { type: string; description: string | null }) => bill.description ?? bill.type;

function contactLine(pg: PgInfo) {
  const parts = [pg.phone ? `call ${pg.phone}` : null, pg.email ? `email ${pg.email}` : null].filter(Boolean);
  return parts.length ? `For any questions, ${parts.join(" or ")}.` : "";
}

// A simple, clean HTML layout shared by all emails.
function layout(
  pg: PgInfo,
  heading: string,
  intro: string,
  rows: [string, string][],
  outro: string,
  extraHtml = ""
) {
  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#666">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;font-weight:600">${escapeHtml(value)}</td></tr>`
    )
    .join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#222">
  <h2 style="margin:0 0 4px">${escapeHtml(pg.name)}</h2>
  <h3 style="margin:0 0 16px;color:#555;font-weight:normal">${escapeHtml(heading)}</h3>
  <p>${escapeHtml(intro)}</p>
  <table style="border-collapse:collapse;margin:12px 0">${rowsHtml}</table>
  ${extraHtml}
  <p>${escapeHtml(outro)}</p>
</div>`;
}

function plainText(pg: PgInfo, intro: string, rows: [string, string][], outro: string, extraLines: string[] = []) {
  return [pg.name, "", intro, "", ...rows.map(([label, value]) => `${label}: ${value}`), ...extraLines, "", outro].join("\n");
}

// The tenant's OTHER pending charges (electricity, extra charges, other months' rent...),
// listed under the bill being emailed, with a total of everything outstanding.
function otherChargesSection(thisBalance: Prisma.Decimal, others: BillInfo[]) {
  if (others.length === 0) return { html: "", lines: [] as string[] };

  const items = others.map((b) => ({
    label: billLabel(b),
    balance: b.amount.minus(b.paidAmount),
    due: formatDate(b.dueDate),
  }));
  const total = items.reduce((sum, item) => sum.plus(item.balance), thisBalance);

  const rowsHtml = items
    .map(
      (item) =>
        `<tr><td style="padding:5px 12px 5px 0;color:#666">${escapeHtml(item.label)} <span style="color:#999">(due ${escapeHtml(item.due)})</span></td>` +
        `<td style="padding:5px 0;font-weight:600;text-align:right">${escapeHtml(formatMoney(item.balance))}</td></tr>`
    )
    .join("");
  const html =
    `<p style="margin:18px 0 4px;font-weight:600">Your other pending charges</p>` +
    `<table style="border-collapse:collapse;margin:4px 0">${rowsHtml}` +
    `<tr><td style="padding:8px 12px 5px 0;border-top:1px solid #ddd;font-weight:600">Total outstanding (including this bill)</td>` +
    `<td style="padding:8px 0 5px;border-top:1px solid #ddd;font-weight:700;text-align:right">${escapeHtml(formatMoney(total))}</td></tr></table>`;

  const lines = [
    "",
    "Your other pending charges:",
    ...items.map((item) => `- ${item.label} (due ${item.due}): ${formatMoney(item.balance)}`),
    "",
    `Total outstanding (including this bill): ${formatMoney(total)}`,
  ];
  return { html, lines };
}

// A new bill (kind "BILL") or a nudge about an overdue one (kind "REMINDER").
export function billEmail(args: {
  tenantName: string;
  pg: PgInfo;
  bill: BillInfo;
  kind: "BILL" | "REMINDER";
  otherCharges?: BillInfo[]; // the tenant's other pending charges, shown under this bill
}) {
  const { tenantName, pg, bill, kind, otherCharges = [] } = args;
  const balance = bill.amount.minus(bill.paidAmount);
  const label = billLabel(bill);

  const rows: [string, string][] = [
    ["Bill", label],
    ["Amount", formatMoney(bill.amount)],
    ...(bill.paidAmount.gt(0) ? ([["Paid so far", formatMoney(bill.paidAmount)]] as [string, string][]) : []),
    ["Balance due", formatMoney(balance)],
    ["Due date", formatDate(bill.dueDate)],
  ];

  const isReminder = kind === "REMINDER";
  const subject = isReminder
    ? `Reminder: ${formatMoney(balance)} overdue since ${formatDate(bill.dueDate)} - ${pg.name}`
    : `${label}: ${formatMoney(balance)} due by ${formatDate(bill.dueDate)} - ${pg.name}`;
  const heading = isReminder ? "Payment reminder" : "Your bill";
  const intro = isReminder
    ? `Hi ${tenantName}, this is a friendly reminder that the payment below is overdue.`
    : `Hi ${tenantName}, here is your bill.`;
  const outro = `Please pay at your earliest convenience and share the payment reference with us. ${contactLine(pg)}`.trim();

  const extra = otherChargesSection(balance, otherCharges);

  return {
    subject,
    text: plainText(pg, intro, rows, outro, extra.lines),
    html: layout(pg, heading, intro, rows, outro, extra.html),
  };
}

// Sent after a payment is recorded.
export function receiptEmail(args: {
  tenantName: string;
  pg: PgInfo;
  receiptNumber: string;
  amount: Prisma.Decimal;
  method: string;
  reference: string | null;
  paidAt: Date;
  bill: { type: string; description: string | null };
  balanceNow: Prisma.Decimal;
}) {
  const { tenantName, pg, receiptNumber, amount, method, reference, paidAt, bill, balanceNow } = args;

  const rows: [string, string][] = [
    ["Receipt number", receiptNumber],
    ["For", billLabel(bill)],
    ["Amount received", formatMoney(amount)],
    ["Method", method.replace(/_/g, " ")],
    ...(reference ? ([["Reference", reference]] as [string, string][]) : []),
    ["Date", formatDateTime(paidAt)],
    ["Balance remaining", formatMoney(balanceNow)],
  ];
  const intro = `Hi ${tenantName}, we have received your payment. Thank you!`;
  const outro = contactLine(pg);

  return {
    subject: `Payment received: ${formatMoney(amount)} (${receiptNumber}) - ${pg.name}`,
    text: plainText(pg, intro, rows, outro),
    html: layout(pg, "Payment receipt", intro, rows, outro),
  };
}
