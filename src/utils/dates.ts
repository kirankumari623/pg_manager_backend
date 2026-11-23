// The product is built for India, so "today" and "this month" follow Indian time (IST, UTC+5:30)
// even though the server itself runs in UTC.

export const IST_OFFSET_MS = 330 * 60 * 1000;

// Midnight (as a UTC date) of today's calendar date in India.
// Bill due dates are stored the same way, so the two can be compared directly.
export function startOfTodayIST(): Date {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

// Current month in India as "YYYY-MM", e.g. "2026-11".
export function currentMonthIST(): string {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`;
}

// "2026-11" -> the first day of that month and of the next month, as plain dates (midnight UTC).
// Returns null if the text is not a valid month. Use `start`/`end` for bill and expense dates.
// `paidFrom`/`paidTo` are the same month's edges shifted to India time, for real moments such as payments.
export function monthRange(month: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  const start = new Date(Date.UTC(year, index, 1));
  const end = new Date(Date.UTC(year, index + 1, 1));
  return {
    start,
    end,
    paidFrom: new Date(start.getTime() - IST_OFFSET_MS),
    paidTo: new Date(end.getTime() - IST_OFFSET_MS),
  };
}
