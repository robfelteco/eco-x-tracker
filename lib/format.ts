// Small display formatters shared across pages.

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

// Written date, e.g. "May 30th". Jay's ask: dates should read as words, not
// ISO slices. Includes the year only when it isn't the current one.
export function writtenDate(d: Date | string | null | undefined): string {
  if (!d) return "never";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (isNaN(dt.getTime())) return "—";
  const month = dt.toLocaleString("en-US", { month: "short" });
  const day = dt.getDate();
  const now = new Date();
  const year = dt.getFullYear() === now.getFullYear() ? "" : ` ${dt.getFullYear()}`;
  return `${month} ${day}${ordinal(day)}${year}`;
}

// "18 days ago" / "today" / "yesterday".
export function daysAgo(days: number | null | undefined): string {
  if (days == null) return "—";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function compact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1000) return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  return n.toLocaleString();
}
