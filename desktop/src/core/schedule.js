/**
 * schedule.js
 *
 * Turns the connector's sync schedule (a six-field NCRONTAB expression such as
 * "0 0 *\/6 * * *") into clock times, and suggests Power BI refresh times.
 *
 * Run locally by Azure Functions Core Tools, the schedule is in this PC's local
 * time: the host reports "0 0 0,6,12,18 * * *" firing at 12:00-04:00 on an
 * Eastern-time machine. On Azure it is UTC unless WEBSITE_TIME_ZONE is set.
 *
 * Only daily patterns are understood (fixed second and minute; hours as *,
 * a list, a range or a step; every day). Anything else returns null and the
 * app shows the raw expression instead.
 */

function parseHours(field) {
  if (field === '*') return range(0, 23);
  const step = /^\*\/(\d+)$/.exec(field);
  if (step) {
    const n = Number(step[1]);
    return n >= 1 && n <= 23 ? range(0, 23).filter((h) => h % n === 0) : null;
  }
  const hours = [];
  for (const part of field.split(',')) {
    const span = /^(\d{1,2})-(\d{1,2})$/.exec(part);
    if (span) {
      const [from, to] = [Number(span[1]), Number(span[2])];
      if (from > to || to > 23) return null;
      hours.push(...range(from, to));
    } else if (/^\d{1,2}$/.test(part) && Number(part) <= 23) {
      hours.push(Number(part));
    } else {
      return null;
    }
  }
  return [...new Set(hours)].sort((a, b) => a - b);
}

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** @returns {{hour: number, minute: number}[] | null} the daily sync times */
function dailyTimes(expression) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 6) return null;
  const [second, minute, hour, day, month, weekday] = fields;
  if (!/^\d{1,2}$/.test(second) || !/^\d{1,2}$/.test(minute) || Number(minute) > 59) return null;
  if (day !== '*' || month !== '*' || weekday !== '*') return null;
  const hours = parseHours(hour);
  return hours ? hours.map((h) => ({ hour: h, minute: Number(minute) })) : null;
}

function addMinutes({ hour, minute }, extra) {
  const total = (hour * 60 + minute + extra) % (24 * 60);
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

function formatTime({ hour, minute }) {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/**
 * Power BI refresh times a little after each sync, capped at what the plan
 * allows (8 a day on Pro), spread across the day.
 */
function suggestRefreshTimes(times, { delayMinutes = 30, maxPerDay = 8 } = {}) {
  const after = times.map((t) => addMinutes(t, delayMinutes));
  if (after.length <= maxPerDay) return after;
  const stride = after.length / maxPerDay;
  return Array.from({ length: maxPerDay }, (_, i) => after[Math.floor(i * stride)]);
}

module.exports = { dailyTimes, suggestRefreshTimes, formatTime };
