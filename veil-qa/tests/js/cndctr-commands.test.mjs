// Tests for the /CNDCTR/ command language, run with `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const C = await import(path.join(here, "../../../apps/cndctr/commands.mjs"));

const TZ = "Europe/Moscow";                      // UTC+3, no DST
const NOW = Date.UTC(2026, 10, 5, 18, 0);        // Thu 2026-11-05 21:00 in Moscow
const local = (ms, tz = TZ) => { const p = C.zonedParts(ms, tz); return `${p.y}-${p.m}-${p.d} ${p.h}:${String(p.mi).padStart(2, "0")} ${C.DAYS[p.weekday]}`; };

test("times parse", () => {
  for (const [i, o] of [["9", "09:00"], ["9am", "09:00"], ["9:30", "09:30"], ["9:30 pm", "21:30"], ["12am", "00:00"],
                        ["12pm", "12:00"], ["21:15", "21:15"], ["noon", "12:00"], ["midnight", "00:00"]]) {
    assert.equal(C.parseTime(i), o, i);
  }
  for (const bad of ["25", "9:75", "13pm", "0am", "soon"]) assert.equal(C.parseTime(bad), null, bad);
});

test("an action with no schedule runs now", () => {
  const c = C.parseCommand("remind me to call Sam", NOW, TZ);
  assert.deepEqual(c, { kind: "task", schedule: { type: "once", at: NOW }, action: { type: "remind", text: "call Sam" } });
});

test("relative times", () => {
  assert.equal(C.parseCommand("in 20 minutes remind me to stretch", NOW, TZ).schedule.at, NOW + 20 * 60_000);
  assert.equal(C.parseCommand("in 2h note x", NOW, TZ).schedule.at, NOW + 2 * 3_600_000);
  assert.equal(C.parseCommand("in 3 days note x", NOW, TZ).schedule.at, NOW + 3 * 86_400_000);
});

test("'at' is the next time that clock time comes round, in the user's zone", () => {
  assert.equal(local(C.parseCommand("at 10pm note x", NOW, TZ).schedule.at), "2026-11-5 22:00 thursday");
  assert.equal(local(C.parseCommand("at 9 note x", NOW, TZ).schedule.at), "2026-11-6 9:00 friday");
});

test("tomorrow defaults to 9:00", () => {
  assert.equal(local(C.parseCommand("tomorrow note x", NOW, TZ).schedule.at), "2026-11-6 9:00 friday");
  assert.equal(local(C.parseCommand("tomorrow at 8am ask scalvs news", NOW, TZ).schedule.at), "2026-11-6 8:00 friday");
});

test("recurring schedules and their next runs", () => {
  const daily = C.parseCommand("every day at 9 remind me to plan", NOW, TZ).schedule;
  assert.deepEqual(daily, { type: "daily", time: "09:00" });
  assert.equal(local(C.nextRun(daily, NOW, TZ)), "2026-11-6 9:00 friday");

  const wk = C.parseCommand("every weekday at 9 remind me to check the board", NOW, TZ).schedule;
  const fri = C.nextRun(wk, NOW, TZ);
  assert.equal(local(fri), "2026-11-6 9:00 friday");
  assert.equal(local(C.nextRun(wk, fri, TZ)), "2026-11-9 9:00 monday");   // skips the weekend

  const mon = C.parseCommand("every monday at 10 ask scalus weekly AI news", NOW, TZ).schedule;
  assert.deepEqual(mon, { type: "weekly", day: 1, time: "10:00" });
  assert.equal(local(C.nextRun(mon, NOW, TZ)), "2026-11-9 10:00 monday");

  const hourly = C.parseCommand("every hour note ping", NOW, TZ).schedule;
  assert.equal(C.nextRun(hourly, NOW, TZ), NOW + 3_600_000);
});

test("daylight-saving time zones keep the wall-clock time", () => {
  const ny = "America/New_York";                 // DST ended Sun 2026-11-01
  const before = Date.UTC(2026, 9, 30, 12);      // Fri Oct 30
  const s = { type: "daily", time: "09:00" };
  let t = before;
  for (let i = 0; i < 4; i++) {
    t = C.nextRun(s, t, ny);
    assert.equal(C.zonedParts(t, ny).h, 9);
  }
});

test("actions", () => {
  assert.deepEqual(C.parseAction("note: buy milk"), { type: "note", text: "buy milk" });
  assert.deepEqual(C.parseAction("ask SCALVS.ai what is Tor?"), { type: "ask", text: "what is Tor?" });
  assert.deepEqual(C.parseAction("remind me stand up"), { type: "remind", text: "stand up" });
  assert.equal(C.parseAction("launch rockets"), null);
});

test("management commands and errors", () => {
  assert.deepEqual(C.parseCommand("help", NOW, TZ), { kind: "help" });
  assert.deepEqual(C.parseCommand("List", NOW, TZ), { kind: "list" });
  assert.deepEqual(C.parseCommand("cancel #2", NOW, TZ), { kind: "cancel", n: 2 });
  assert.equal(C.parseCommand("launch rockets", NOW, TZ).kind, "error");
  assert.equal(C.parseCommand("at 25 note x", NOW, TZ).kind, "error");
  assert.equal(C.parseCommand("", NOW, TZ).kind, "error");
  assert.equal(C.parseCommand("x".repeat(1001), NOW, TZ).kind, "error");
});

test("schedules read back in plain English", () => {
  assert.equal(C.describeSchedule({ type: "weekly", day: 1, time: "10:00" }, TZ), "every Monday at 10:00");
  assert.equal(C.describeSchedule({ type: "once", at: NOW }, TZ), "on 2026-11-05 at 21:00");
  assert.ok(C.validTimeZone("Europe/Moscow"));
  assert.ok(!C.validTimeZone("Mars/Olympus"));
});
