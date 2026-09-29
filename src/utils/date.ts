/**
 * Date formatting utilities for tool output.
 *
 * @module utils/date
 */

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * Formats a date as an ISO 8601 timestamp in the local timezone, including
 * the UTC offset (e.g. "2026-09-29T17:19:18+01:00").
 *
 * Unlike `toLocaleDateString()`, this keeps the time of day and does not
 * depend on the system locale. Unlike `toISOString()`, it stays in local time,
 * matching what Mail.app displays, while the offset keeps it unambiguous.
 *
 * @param date - Date to format
 * @returns ISO 8601 timestamp with seconds and UTC offset
 */
export function formatTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);

  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`
  );
}
