/**
 * Designer-cost helpers.
 *
 * Every newly created label carries a one-off design charge of Rs. 500 per
 * distinct label size. Charges are grouped into calendar months using the
 * business timezone (Asia/Karachi, UTC+05:00), so a label created just after
 * midnight on the 1st belongs to that month even though the server may be
 * running in UTC.
 */

export const DESIGN_CHARGE_PER_SIZE = 500;

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Returns the Asia/Karachi month key (YYYY-MM) for a date. */
export function monthKeyForDate(date: Date): string {
  const shifted = new Date(date.getTime() + PKT_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}`;
}

export function currentMonthKey(now: Date = new Date()): string {
  return monthKeyForDate(now);
}

/** Validates a user-supplied YYYY-MM value, returning null when invalid. */
export function normalizeMonthKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = MONTH_KEY_PATTERN.exec(value.trim());
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${pad2(month)}`;
}

/** UTC boundaries of a YYYY-MM month in Asia/Karachi. */
export function monthRangeFor(monthKey: string): { start: Date; end: Date } {
  const match = MONTH_KEY_PATTERN.exec(monthKey);
  if (!match) {
    throw new Error(`Invalid month key: ${monthKey}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = new Date(Date.UTC(year, month - 1, 1) - PKT_OFFSET_MS);
  const end = new Date(Date.UTC(year, month, 1) - PKT_OFFSET_MS);
  return { start, end };
}

/** Fixed design charge for a label with the given number of distinct sizes. */
export function computeDesignerCharge(sizeCount: number): number {
  if (!Number.isFinite(sizeCount) || sizeCount <= 0) return 0;
  return Math.round(sizeCount) * DESIGN_CHARGE_PER_SIZE;
}

export function shiftMonthKey(monthKey: string, delta: number): string {
  const match = MONTH_KEY_PATTERN.exec(monthKey);
  if (!match) {
    throw new Error(`Invalid month key: ${monthKey}`);
  }
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1 + delta, 1)
  );
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}
