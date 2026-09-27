const zone = 'Europe/Moscow';
const calendar = new Intl.DateTimeFormat('en-US', {
  timeZone: zone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});
const offsetFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: zone,
  timeZoneName: 'shortOffset',
});
const weekday: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
function localDay(date: Date) {
  const parts = Object.fromEntries(calendar.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    dow: weekday[parts.weekday],
  };
}
function utcAtMoscowMidnight(year: number, month: number, day: number): string {
  const approximate = new Date(Date.UTC(year, month - 1, day));
  const label =
    offsetFormat.formatToParts(approximate).find((x) => x.type === 'timeZoneName')?.value ||
    'GMT+3';
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(label);
  if (!match) throw new Error('Не удалось определить московское время');
  const offset = (Number(match[2]) * 60 + Number(match[3] || 0)) * (match[1] === '+' ? 1 : -1);
  return new Date(Date.UTC(year, month - 1, day) - offset * 60000).toISOString();
}
export function weekBounds(date: Date) {
  const local = localDay(date);
  const monday = new Date(Date.UTC(local.year, local.month - 1, local.day - local.dow));
  const next = new Date(monday.getTime() + 7 * 86400000);
  return {
    startDate: monday.toISOString().slice(0, 10),
    startIso: utcAtMoscowMidnight(
      monday.getUTCFullYear(),
      monday.getUTCMonth() + 1,
      monday.getUTCDate(),
    ),
    endIso: utcAtMoscowMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}
