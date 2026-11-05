// /CNDCTR/ command language: plain-English commands and schedules.
//
//   help · list · notes · cancel 2
//   [when] <action>
//
// when:   now · in 10 minutes · in 2 hours · in 3 days · at 9 · at 9:30pm · at noon
//         tomorrow [at 8am] · every day|daily [at 9] · every weekday [at 9]
//         every monday [at 9] · every hour|hourly
// action: remind me to <text> · note <text> · ask scalvs|scalus <question>
//
// Times are the user's local time (an IANA time zone such as Europe/Moscow).

export const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

// ---- time zones -------------------------------------------------------------

export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric",
    day: "numeric", hour: "numeric", minute: "numeric", weekday: "long" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, weekday: DAYS.indexOf(p.weekday.toLowerCase()) };
}

function offsetAt(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / MS.minute) * MS.minute;
}

/** The instant a wall-clock time happens in a time zone. */
export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetAt(guess, tz);
  const again = guess - offsetAt(t, tz);
  if (again !== t) t = again;
  return t;
}

/** Next run strictly after `after` (ms) for a schedule. */
export function nextRun(schedule, after, tz) {
  if (schedule.type === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.type === "hourly") {
    const base = Math.floor(after / MS.hour) * MS.hour;
    for (let k = 0; k < 3; k++) {
      const t = base + k * MS.hour + schedule.minute * MS.minute;
      if (t > after) return t;
    }
  }
  const [hh, mm] = schedule.time.split(":").map(Number);
  const start = zonedParts(after, tz);
  for (let k = 0; k <= 8; k++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + k));
    const t = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
    if (t <= after) continue;
    const wd = zonedParts(t, tz).weekday;
    if (schedule.type === "daily") return t;
    if (schedule.type === "weekdays" && wd >= 1 && wd <= 5) return t;
    if (schedule.type === "weekly" && wd === schedule.day) return t;
  }
  return null;
}

// ---- parsing -----------------------------------------------------------------

/** "9", "9am", "9:30", "21:15", "9:30 pm", "noon", "midnight" -> "HH:MM" or null. */
export function parseTime(text) {
  const t = text.trim().toLowerCase();
  if (t === "noon") return "12:00";
  if (t === "midnight") return "00:00";
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (mi > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === "pm" ? 12 : 0);
  } else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

const TIME_RE = String.raw`(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)`;
const AT = new RegExp(String.raw`^at\s+${TIME_RE}\s+(.*)$`, "i");
const AT_TAIL = new RegExp(String.raw`^(?:at\s+${TIME_RE}\s+)?(.*)$`, "i");

export function parseAction(text) {
  const t = text.trim().replace(/\s+/g, " ");
  let m;
  if ((m = /^remind me(?: to)? (.+)$/i.exec(t))) return { type: "remind", text: m[1] };
  if ((m = /^(?:save )?note:? (.+)$/i.exec(t))) return { type: "note", text: m[1] };
  if ((m = /^ask (?:scalvs|scalus)(?:\.ai)?:? (.+)$/i.exec(t))) return { type: "ask", text: m[1] };
  return null;
}

export function describeAction(a) {
  if (a.type === "remind") return `remind you to ${a.text}`;
  if (a.type === "note") return `save the note "${a.text}"`;
  return `ask SCALVS.ai: ${a.text}`;
}

/** Parse a command. `now` in ms, `tz` an IANA zone. */
export function parseCommand(input, now, tz) {
  const text = String(input || "").trim().replace(/\s+/g, " ");
  if (!text) return { kind: "error", message: "Type a command, or \"help\"." };
  if (text.length > 1000) return { kind: "error", message: "That command is too long (1000 characters at most)." };
  const lower = text.toLowerCase();
  if (lower === "help" || lower === "?") return { kind: "help" };
  if (lower === "list" || lower === "tasks") return { kind: "list" };
  if (lower === "notes") return { kind: "notes" };
  let m;
  if ((m = /^(?:cancel|delete|stop) (?:task )?#?(\d+)$/i.exec(text))) return { kind: "cancel", n: +m[1] };

  let schedule = null, rest = text;
  const once = at => ({ type: "once", at });

  if ((m = /^now (.+)$/i.exec(text))) {
    schedule = once(now); rest = m[1];
  } else if ((m = /^in (\d{1,4}) ?(minutes?|mins?|m|hours?|hrs?|h|days?|d) (.+)$/i.exec(text))) {
    const unit = m[2][0].toLowerCase() === "m" ? MS.minute : m[2][0].toLowerCase() === "h" ? MS.hour : MS.day;
    const n = +m[1];
    if (n < 1) return { kind: "error", message: "Use a time at least 1 minute from now." };
    schedule = once(now + n * unit); rest = m[3];
  } else if ((m = AT.exec(text))) {
    const time = parseTime(m[1]);
    if (!time) return { kind: "error", message: `I don't understand the time "${m[1]}".` };
    schedule = once(nextRun({ type: "daily", time }, now, tz)); rest = m[2];
  } else if ((m = /^tomorrow (.+)$/i.exec(text))) {
    const t = AT_TAIL.exec(m[1]);
    const time = t[1] ? parseTime(t[1]) : "09:00";
    if (!time) return { kind: "error", message: `I don't understand the time "${t[1]}".` };
    const p = zonedParts(now, tz);
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
    const [hh, mm] = time.split(":").map(Number);
    schedule = once(zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz)); rest = t[2];
  } else if ((m = /^(?:every hour|hourly) (.+)$/i.exec(text))) {
    schedule = { type: "hourly", minute: 0 }; rest = m[1];
  } else if ((m = /^(?:every day|daily|every weekday|every (sunday|monday|tuesday|wednesday|thursday|friday|saturday)) (.+)$/i.exec(text))) {
    const t = AT_TAIL.exec(m[2]);
    const time = t[1] ? parseTime(t[1]) : "09:00";
    if (!time) return { kind: "error", message: `I don't understand the time "${t[1]}".` };
    if (m[1]) schedule = { type: "weekly", day: DAYS.indexOf(m[1].toLowerCase()), time };
    else if (/^every weekday/i.test(text)) schedule = { type: "weekdays", time };
    else schedule = { type: "daily", time };
    rest = t[2];
  } else {
    schedule = once(now);
  }

  const action = parseAction(rest);
  if (!action) {
    return { kind: "error", message: `I don't know how to "${rest}". Try "remind me to …", "note …" or "ask scalvs …", or type help.` };
  }
  return { kind: "task", schedule, action };
}

export function describeSchedule(s, tz) {
  const two = n => String(n).padStart(2, "0");
  if (s.type === "once") {
    const p = zonedParts(s.at, tz);
    return `on ${p.y}-${two(p.m)}-${two(p.d)} at ${two(p.h)}:${two(p.mi)}`;
  }
  if (s.type === "hourly") return "every hour";
  if (s.type === "daily") return `every day at ${s.time}`;
  if (s.type === "weekdays") return `every weekday at ${s.time}`;
  return `every ${DAYS[s.day][0].toUpperCase()}${DAYS[s.day].slice(1)} at ${s.time}`;
}

export const HELP = [
  "Commands run now, or on a schedule you write in plain English:",
  "  remind me to call Sam",
  "  in 20 minutes remind me to stretch",
  "  at 6pm note pick up the drive",
  "  tomorrow at 8am ask scalvs what happened in markets overnight",
  "  every weekday at 9 remind me to check the board",
  "  every monday at 10 ask scalus summarize this week's AI news",
  "Manage them with: list · notes · cancel 2 · help",
].join("\n");
