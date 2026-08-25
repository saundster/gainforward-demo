/* GainForward — calendar scheduling.
   What this actually does without a backend or OAuth:
     1. Generates a real, standards-compliant .ics invite (with reminders
        baked in as VALARM blocks) that opens in Outlook desktop, Apple
        Calendar, etc.
     2. Builds one-click "Add to Google Calendar" / "Add to Outlook" web
        links — Google and Microsoft's own public deep-link URLs, no API
        key needed.
     3. When a relationship ends, generates a matching CANCEL .ics (same
        UID, incremented SEQUENCE) so removing it from a real calendar is
        one click instead of a manual hunt-and-delete.

   What it can't do without a backend: silently create/update/cancel an
   event directly inside someone's Outlook/Google account with zero clicks.
   That needs delegated OAuth (Microsoft Graph `/events`, Google Calendar
   API `events.insert`/`events.delete`) plus a server to hold refresh
   tokens — see the "Making this fully automatic" note in README.md. */

function icsDate(date) {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function escapeICSText(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Builds an RFC 5545 .ics file as text.
 * @param {object} opts
 *   uid, sequence, method ("REQUEST"|"CANCEL"), status ("CONFIRMED"|"CANCELLED"),
 *   title, description, location, start (Date), durationMins,
 *   organizer {name,email}, attendees [{name,email}], reminders [minutesBefore,...]
 */
function buildICS(opts) {
  const start = opts.start;
  const end = new Date(start.getTime() + opts.durationMins * 60000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GainForward//RateGain//EN",
    `METHOD:${opts.method}`,
    "BEGIN:VEVENT",
    `UID:${opts.uid}`,
    `SEQUENCE:${opts.sequence}`,
    `STATUS:${opts.status}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${escapeICSText(opts.title)}`,
    `DESCRIPTION:${escapeICSText(opts.description)}`,
  ];
  if (opts.location) lines.push(`LOCATION:${escapeICSText(opts.location)}`);
  if (opts.organizer) lines.push(`ORGANIZER;CN=${escapeICSText(opts.organizer.name)}:mailto:${opts.organizer.email}`);
  (opts.attendees || []).forEach((a) => {
    if (a.email) lines.push(`ATTENDEE;CN=${escapeICSText(a.name)};RSVP=TRUE:mailto:${a.email}`);
  });
  if (opts.method === "REQUEST") {
    (opts.reminders || []).forEach((minutesBefore) => {
      lines.push("BEGIN:VALARM", `TRIGGER:-PT${minutesBefore}M`, "ACTION:DISPLAY", "DESCRIPTION:Reminder", "END:VALARM");
    });
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

function downloadICS(filename, icsText) {
  const blob = new Blob([icsText], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Google's public "quick add" URL — no API key required. Reminders default to the viewer's own Google Calendar settings. */
function googleCalendarLink({ title, description, location, start, durationMins }) {
  const end = new Date(start.getTime() + durationMins * 60000);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${icsDate(start)}/${icsDate(end)}`,
    details: description,
    location: location || "",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Outlook (Office 365 web) deep link — no API key required. Reminders default to the viewer's own Outlook settings. */
function outlookWebLink({ title, description, location, start, durationMins, attendees }) {
  const end = new Date(start.getTime() + durationMins * 60000);
  const params = new URLSearchParams({
    subject: title,
    body: description,
    location: location || "",
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    to: (attendees || []).map((a) => a.email).filter(Boolean).join(";"),
  });
  return `https://outlook.office.com/calendar/0/deeplink/compose?${params.toString()}`;
}

/** Opens a real email draft in the user's own mail client — the honest, backend-free way to "nudge" someone. */
function buildMailtoLink(to, subject, body) {
  const params = new URLSearchParams({ subject, body });
  return `mailto:${to}?${params.toString()}`;
}
