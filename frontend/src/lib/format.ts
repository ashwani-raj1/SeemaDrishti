/** Formatting a control room can read at 3 a.m. */

const HHMMSS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

/** 02:14:33 -- the form every timestamp in the brief's plates uses. */
export const clockTime = (iso: string) => new Date(iso).toLocaleTimeString([], HHMMSS);

export const dateTime = (iso: string) =>
  `${new Date(iso).toLocaleDateString([], { day: "2-digit", month: "short" })} ${clockTime(iso)}`;

export function relative(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** person_vehicle -> Person vehicle; fence_line -> Fence line. */
export const humanise = (value: string) =>
  value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export const percent = (value: number | null | undefined) =>
  value === null || value === undefined ? "--" : `${Math.round(value * 100)}%`;
