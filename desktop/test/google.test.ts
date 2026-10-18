import { createHash } from "node:crypto";
import type { ProposedAction } from "@kiki/shared";
import { describe, expect, it } from "vitest";
import {
  applyEdits,
  buildMime,
  calendarTemplateUrl,
  describeAction,
  emailFromIdToken,
  gmailComposeUrl,
  localIso,
  pkceChallenge,
  pkcePair,
  summarizeEvents,
  summarizeTasks,
  toEventResource,
  toTaskResource,
} from "../src/main/google/format.ts";

const EVENT: Extract<ProposedAction, { kind: "event" }> = {
  id: "e1",
  kind: "event",
  title: "Lunch with Sam",
  start: "2026-10-20T13:00",
  end: "2026-10-20T14:00",
  location: "Café X",
};

const EMAIL: Extract<ProposedAction, { kind: "email" }> = {
  id: "m1",
  kind: "email",
  to: ["sam@example.com"],
  cc: ["kim@example.com"],
  subject: "Déjeuner mardi",
  body: "Hi Sam,\nSee you Tuesday.",
};

function decodeMime(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

describe("calendar events", () => {
  it("builds timed events in the person's time zone", () => {
    expect(toEventResource(EVENT, "America/Toronto")).toEqual({
      summary: "Lunch with Sam",
      start: { dateTime: "2026-10-20T13:00:00", timeZone: "America/Toronto" },
      end: { dateTime: "2026-10-20T14:00:00", timeZone: "America/Toronto" },
      location: "Café X",
    });
  });

  it("ends all-day events the day after their last day", () => {
    const resource = toEventResource(
      { ...EVENT, allDay: true, start: "2026-10-31", end: "2026-11-01", attendees: ["a@b.co"] },
      "UTC",
    );
    expect(resource).toMatchObject({
      start: { date: "2026-10-31" },
      end: { date: "2026-11-02" },
      attendees: [{ email: "a@b.co" }],
    });
  });

  it("prefills Google Calendar's add-event page", () => {
    const url = new URL(calendarTemplateUrl(EVENT, "America/Toronto"));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("dates")).toBe("20261020T130000/20261020T140000");
    expect(url.searchParams.get("ctz")).toBe("America/Toronto");
    expect(url.searchParams.get("location")).toBe("Café X");
    const allDay = new URL(calendarTemplateUrl({ ...EVENT, allDay: true, start: "2026-10-20", end: "2026-10-20" }, "UTC"));
    expect(allDay.searchParams.get("dates")).toBe("20261020/20261021");
    expect(allDay.searchParams.has("ctz")).toBe(false);
  });

  it("summarizes events for Claude", () => {
    expect(summarizeEvents([])).toBe("No events in that time.");
    expect(
      summarizeEvents([
        {
          summary: "Standup",
          start: { dateTime: "2026-10-22T09:30:00-04:00" },
          end: { dateTime: "2026-10-22T09:45:00-04:00" },
        },
        { summary: "Holiday", start: { date: "2026-10-23" }, end: { date: "2026-10-24" }, location: "Home" },
        { summary: "Gone", status: "cancelled", start: { date: "2026-10-23" } },
      ]),
    ).toBe("- Thu 2026-10-22 09:30–09:45: Standup\n- Fri 2026-10-23 (all day): Holiday @ Home");
  });
});

describe("tasks", () => {
  it("keeps only the due date", () => {
    expect(toTaskResource({ id: "t", kind: "task", title: "Renew passport", due: "2026-10-23" })).toEqual({
      title: "Renew passport",
      due: "2026-10-23T00:00:00.000Z",
    });
  });

  it("summarizes tasks for Claude", () => {
    expect(
      summarizeTasks([
        { title: "Renew passport", due: "2026-10-23T00:00:00.000Z", status: "needsAction" },
        { title: "Done thing", status: "completed" },
        { title: "  " },
      ]),
    ).toBe("- [ ] Renew passport (due Fri 2026-10-23)\n- [x] Done thing");
  });
});

describe("emails", () => {
  it("builds a UTF-8 MIME message for Gmail", () => {
    const mime = decodeMime(buildMime(EMAIL));
    const [headers, body] = mime.split("\r\n\r\n");
    expect(headers).toContain("To: sam@example.com");
    expect(headers).toContain("Cc: kim@example.com");
    expect(headers).toContain(`Subject: =?UTF-8?B?${Buffer.from("Déjeuner mardi").toString("base64")}?=`);
    expect(headers).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Hi Sam,\r\nSee you Tuesday.");
  });

  it("can't be given extra headers through its fields", () => {
    const mime = decodeMime(buildMime({ ...EMAIL, cc: undefined, subject: "Hi\r\nBcc: evil@example.com" }));
    expect(mime).not.toMatch(/^Bcc:/m);
    expect(mime).toContain("Subject: Hi Bcc: evil@example.com");
  });

  it("prefills Gmail's compose window", () => {
    const url = new URL(gmailComposeUrl(EMAIL));
    expect(url.searchParams.get("view")).toBe("cm");
    expect(url.searchParams.get("to")).toBe("sam@example.com");
    expect(url.searchParams.get("cc")).toBe("kim@example.com");
    expect(url.searchParams.get("su")).toBe("Déjeuner mardi");
    expect(url.searchParams.get("body")).toBe("Hi Sam,\nSee you Tuesday.");
  });
});

describe("applyEdits", () => {
  it("takes the card's edits but never its id or kind", () => {
    const edited = applyEdits(EVENT, { ...EVENT, id: "other", kind: "task", title: "Lunch", attendees: ["sam@example.com"] });
    expect(edited).toEqual({ ...EVENT, title: "Lunch", attendees: ["sam@example.com"] });
  });

  it("rejects bad times and addresses", () => {
    expect(applyEdits(EVENT, { start: "tomorrow" })).toEqual({ error: "Check the start and end times." });
    expect(applyEdits(EVENT, { start: "2026-10-20T15:00" })).toEqual({ error: "The event ends before it starts." });
    expect(applyEdits(EMAIL, { to: ["sam"] })).toEqual({ error: '"sam" isn\'t an email address.' });
  });

  it("switches an event to all day", () => {
    expect(applyEdits(EVENT, { allDay: true, start: "2026-10-20", end: "2026-10-20" })).toMatchObject({
      allDay: true,
      start: "2026-10-20",
    });
  });

  it("keeps the email's send choice and drops cleared fields", () => {
    expect(applyEdits({ ...EMAIL, send: true }, { cc: [], subject: "Lunch" })).toEqual({
      id: "m1",
      kind: "email",
      to: ["sam@example.com"],
      subject: "Lunch",
      body: EMAIL.body,
      send: true,
    });
  });
});

describe("helpers", () => {
  it("makes PKCE pairs", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    // RFC 7636's example.
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("reads the email from an id token", () => {
    const payload = Buffer.from(JSON.stringify({ email: "me@gmail.com" })).toString("base64url");
    expect(emailFromIdToken(`header.${payload}.sig`)).toBe("me@gmail.com");
    expect(emailFromIdToken("junk")).toBeUndefined();
  });

  it("writes local times with their offset", () => {
    expect(localIso(new Date(2026, 9, 16, 14, 3, 7))).toMatch(/^2026-10-16T14:03:07[+-]\d{2}:\d{2}$/);
  });

  it("describes actions for Claude", () => {
    expect(describeAction(EVENT)).toBe('"Lunch with Sam", Tue 2026-10-20 13:00–14:00 at Café X.');
    expect(describeAction({ id: "t", kind: "task", title: "Pay rent", due: "2026-11-01" })).toBe(
      '"Pay rent", due Sun 2026-11-01.',
    );
    expect(describeAction(EMAIL)).toBe('"Déjeuner mardi" to sam@example.com.');
  });
});
