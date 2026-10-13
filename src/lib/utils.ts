import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Lightweight relative-time formatter for the inbox list.
 * "now" / "5m" / "3h" / "Yesterday" / "Mar 12" / "2024"
 */
export function relativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffH = Math.floor(diffMs / 3_600_000);
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const wasYesterday = date.toDateString() === yesterday.toDateString();

  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  if (sameDay) return `${diffH}h`;
  if (wasYesterday) return "Yesterday";
  if (now.getFullYear() === date.getFullYear()) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return date.getFullYear().toString();
}
