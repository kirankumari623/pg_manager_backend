import { Router } from "express";
import { z } from "zod";
import { BedStatus, BillStatus, Prisma, Role } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { asyncHandler } from "../../utils/asyncHandler";
import { authenticate, orgIdOf, requireRole } from "../../middleware/auth";
import { currentMonthIST, IST_OFFSET_MS, monthRange } from "../../utils/dates";

// Profit and loss is for the owner's eyes only, so staff cannot open these.
export const reportsRouter = Router();
reportsRouter.use(authenticate, requireRole(Role.OWNER));

const zero = () => new Prisma.Decimal(0);
const orZero = (value: Prisma.Decimal | null | undefined) => value ?? zero();

function monthFromQuery(value: unknown) {
  const month = typeof value === "string" ? value : currentMonthIST();
  const range = monthRange(month);
  if (!range) throw HttpError.badRequest("month must look like 2026-11");
  return { month, ...range };
}

// GET /api/reports/monthly?month=2026-11
// Money in (payments received), money out (expenses), profit, and how full the PG was.
reportsRouter.get(
  "/monthly",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const { month, start, end, paidFrom, paidTo } = monthFromQuery(req.query.month);

    const paidInMonth = { organizationId, paidAt: { gte: paidFrom, lt: paidTo } };
    const expenseInMonth = { organizationId, expenseDate: { gte: start, lt: end } };
    // A stay that has not ended by the last moment of the month was occupying its bed.
    const stillThere = { organizationId, checkInDate: { lt: paidTo }, OR: [{ checkOutDate: null }, { checkOutDate: { gte: paidTo } }] };

    const [incomeByMethod, billsDue, expenseByCategory, totalBeds, occupiedAtMonthEnd, moveIns, moveOuts] =
      await Promise.all([
        prisma.payment.groupBy({ by: ["method"], where: paidInMonth, _sum: { amount: true }, _count: { _all: true } }),
        prisma.bill.aggregate({
          where: { organizationId, status: { not: BillStatus.CANCELLED }, dueDate: { gte: start, lt: end } },
          _sum: { amount: true, paidAmount: true },
          _count: { _all: true },
        }),
        prisma.expense.groupBy({ by: ["category"], where: expenseInMonth, _sum: { amount: true }, _count: { _all: true } }),
        prisma.bed.count({ where: { organizationId, status: { not: BedStatus.MAINTENANCE } } }),
        prisma.stay.count({ where: stillThere }),
        prisma.stay.count({ where: { organizationId, checkInDate: { gte: paidFrom, lt: paidTo } } }),
        prisma.stay.count({ where: { organizationId, checkOutDate: { gte: paidFrom, lt: paidTo } } }),
      ]);

    const income = incomeByMethod.reduce((sum, g) => sum.plus(orZero(g._sum.amount)), zero());
    const expenses = expenseByCategory.reduce((sum, g) => sum.plus(orZero(g._sum.amount)), zero());
    const billed = orZero(billsDue._sum.amount);
    const collectedOnBills = orZero(billsDue._sum.paidAmount);

    res.json({
      month,
      // Cash basis: income is money that actually arrived this month, whichever month it was for.
      income: {
        total: income,
        paymentCount: incomeByMethod.reduce((n, g) => n + g._count._all, 0),
        byMethod: incomeByMethod
          .map((g) => ({ method: g.method, amount: orZero(g._sum.amount), count: g._count._all }))
          .sort((a, b) => b.amount.comparedTo(a.amount)),
      },
      expenses: {
        total: expenses,
        byCategory: expenseByCategory
          .map((g) => ({ category: g.category, amount: orZero(g._sum.amount), count: g._count._all }))
          .sort((a, b) => b.amount.comparedTo(a.amount)),
      },
      profit: income.minus(expenses),
      // Bills that fall due in the month, and how much of them is still unpaid.
      billing: { billed, collected: collectedOnBills, pending: billed.minus(collectedOnBills), billCount: billsDue._count._all },
      occupancy: {
        // Beds in use (not under maintenance) as of today, versus beds filled on the last day of the month.
        totalBeds,
        occupiedAtMonthEnd,
        occupancyPercent: totalBeds === 0 ? 0 : Math.round((occupiedAtMonthEnd / totalBeds) * 1000) / 10,
        moveIns,
        moveOuts,
      },
    });
  })
);

// GET /api/reports/trend?months=6&to=2026-11
// Income, expenses and profit for each of the last N months (oldest first) - ready for a chart.
reportsRouter.get(
  "/trend",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const months = z.coerce.number().int().min(1).max(12).safeParse(req.query.months ?? 6);
    if (!months.success) throw HttpError.badRequest("months must be between 1 and 12");
    const last = monthFromQuery(req.query.to);

    const [lastYear, lastMonth] = last.month.split("-").map(Number);
    const keys: string[] = [];
    for (let i = months.data - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(lastYear, lastMonth - 1 - i, 1));
      keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    }
    const first = monthRange(keys[0])!;

    const [payments, expenses] = await Promise.all([
      prisma.payment.findMany({
        where: { organizationId, paidAt: { gte: first.paidFrom, lt: last.paidTo } },
        select: { amount: true, paidAt: true },
      }),
      prisma.expense.findMany({
        where: { organizationId, expenseDate: { gte: first.start, lt: last.end } },
        select: { amount: true, expenseDate: true },
      }),
    ]);

    const rows = new Map(keys.map((key) => [key, { month: key, income: zero(), expenses: zero() }]));
    const keyOf = (date: Date) => date.toISOString().slice(0, 7);
    for (const p of payments) {
      const row = rows.get(keyOf(new Date(p.paidAt.getTime() + IST_OFFSET_MS))); // India's calendar month
      if (row) row.income = row.income.plus(p.amount);
    }
    for (const e of expenses) {
      const row = rows.get(keyOf(e.expenseDate));
      if (row) row.expenses = row.expenses.plus(e.amount);
    }

    res.json({ months: keys.map((key) => { const r = rows.get(key)!; return { ...r, profit: r.income.minus(r.expenses) }; }) });
  })
);

// ---------------------------------------------------------------------------
// CSV export - opens in Excel / Google Sheets.
// ---------------------------------------------------------------------------

// Cells starting with = + - @ can run as formulas in Excel, so they get a leading ' to keep them as plain text.
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const toCsv = (header: string[], rows: unknown[][]) =>
  "﻿" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";

const day = (date: Date) => date.toISOString().slice(0, 10);
// A real moment, written in India time: 2026-11-13 14:05
const istMoment = (date: Date) => new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");

const exportTypeSchema = z.enum(["payments", "expenses", "bills"]);

// GET /api/reports/export?type=payments|expenses|bills&month=2026-11
// "bills" are the bills that fall due in that month.
reportsRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    const organizationId = orgIdOf(req);
    const type = exportTypeSchema.safeParse(req.query.type);
    if (!type.success) throw HttpError.badRequest("type must be payments, expenses or bills");
    const { month, start, end, paidFrom, paidTo } = monthFromQuery(req.query.month);

    let csv: string;
    if (type.data === "payments") {
      const payments = await prisma.payment.findMany({
        where: { organizationId, paidAt: { gte: paidFrom, lt: paidTo } },
        include: { tenant: { select: { name: true, phone: true } }, bill: { select: { type: true, description: true } } },
        orderBy: { paidAt: "asc" },
        take: 5000,
      });
      csv = toCsv(
        ["Receipt", "Paid at (IST)", "Tenant", "Phone", "For", "Method", "Reference", "Amount"],
        payments.map((p) => [p.receiptNumber, istMoment(p.paidAt), p.tenant.name, p.tenant.phone, p.bill.description ?? p.bill.type, p.method, p.reference, p.amount.toFixed(2)])
      );
    } else if (type.data === "expenses") {
      const expenses = await prisma.expense.findMany({
        where: { organizationId, expenseDate: { gte: start, lt: end } },
        include: { property: { select: { name: true } } },
        orderBy: { expenseDate: "asc" },
        take: 5000,
      });
      csv = toCsv(
        ["Date", "Category", "Description", "Paid to", "Property", "Amount"],
        expenses.map((e) => [day(e.expenseDate), e.category, e.description, e.paidTo, e.property?.name, e.amount.toFixed(2)])
      );
    } else {
      const bills = await prisma.bill.findMany({
        where: { organizationId, dueDate: { gte: start, lt: end } },
        include: { tenant: { select: { name: true, phone: true } } },
        orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
        take: 5000,
      });
      csv = toCsv(
        ["Due date", "Tenant", "Phone", "Type", "Description", "Amount", "Paid", "Balance", "Status"],
        bills.map((b) => [
          day(b.dueDate), b.tenant.name, b.tenant.phone, b.type, b.description, b.amount.toFixed(2), b.paidAmount.toFixed(2),
          // A cancelled bill owes nothing.
          b.status === BillStatus.CANCELLED ? "0.00" : b.amount.minus(b.paidAmount).toFixed(2),
          b.status,
        ])
      );
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${type.data}-${month}.csv"`);
    res.send(csv);
  })
);
