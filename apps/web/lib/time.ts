/**
 * When something happened, in real time: "just now", "4 min ago", "2 h ago", then a date. Game days
 * are short (minutes), so a day number would read as though the world had run for months.
 */
export function realTime(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const seconds = Math.round((now - at.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 6 * 3_600) return `${Math.round(seconds / 3_600)} h ago`;
  return at.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
