# GainForward — RateGain Mentorship Dashboard (prototype)

A working HTML/CSS/JS prototype of the "GainForward" mentorship & peer-learning
dashboard described in the RateGain Mentorship & Peer Learning Ecosystem deck
and SOP. No build step, no dependencies — open `index.html` or serve the folder.

## Run it

```bash
# from this folder
npx serve .
```

Or just double-click `index.html`. Everything (state, requests, journeys,
settings) persists to the browser's `localStorage`, so a refresh won't lose
your demo data.

## What's wired up

- **Home** — the 3 primary CTAs ("I want to become a Mentor," "I want to
  become a Mentee," Learning Resources), Top Mentors, Your Active Journey,
  Your Growth Profile. The two role CTAs are short, focused forms (why you
  mentor / your skills / your time — or what you want to learn / your skill
  level / your time / your goal) layered on top of the base profile from
  onboarding; becoming a mentee drops you straight into the Directory.
- **Learning Resources** — a tabbed modal: FAQs, Best Practices, For
  Mentors, For Mentees, Do's & Don'ts, Making the Most of a Connection, and
  a LinkedIn Learning section linking real, existing courses (verified
  titles/instructors/URLs — confirm access in your own org's catalog).
- **Directory** — search/filter the roster, see a live weighted match score
  against your profile (SOP Section 17 rubric), send a mentorship request.
- **My Journey** — the 5-stage/12-week stepper, session logging, Week-6
  midpoint pulse check, Week-12 final reflection.
- **Insights** — the SOP pilot scorecard (Adoption / Relationship quality /
  Learning impact), computed live from requests, journeys, pulses and
  reflections — not static numbers.
- **Admin · PD Console** — matching queue with the 6-item Match Quality
  Checklist, roster management, no-fault rematch, and the 4 decision gates.
- **Calendar scheduling** — from My Journey, "Schedule a conversation" builds
  a real calendar invite (with reminders) for both participants, one click
  to add to Google Calendar or Outlook, or download the `.ics`. If the
  relationship ends (rematch, or a final reflection that doesn't choose
  "continue"), every not-yet-occurred meeting is cancelled automatically in
  the app, and a matching cancellation file is generated so clearing it off
  the real calendar is one click.
- **Nudges** — mentor, mentee, or PD can send a manual reminder from My
  Journey or the Admin roster. It opens a real email draft in the sender's
  own mail client (pre-filled, context-aware — references the next scheduled
  conversation when there is one), and logs the nudge to Admin's "Recent
  nudges" — no backend, nothing sent without the sender hitting send.
- **Mandatory onboarding** — a first-run "create your profile" screen blocks
  the rest of the app until completed (no default demo identity beyond a
  placeholder). The same form doubles as "My profile" for later edits.

## Calendar scheduling — what's real vs. what needs a backend

This runs with no server and no OAuth, so it uses the parts of calendar
scheduling that work over open, public mechanisms:

- **`.ics` download** (`js/calendar.js` → `buildICS`) — a real RFC 5545
  file, with `VALARM` reminders (1 day + 30 min before) baked in. Opens
  correctly in Outlook desktop, Apple Calendar, etc.
- **"Add to Google Calendar" / "Add to Outlook"** — each vendor's own public
  quick-add URL (`calendar.google.com/calendar/render`,
  `outlook.office.com/calendar/.../deeplink/compose`). No API key needed,
  but reminders fall back to the viewer's own calendar default — these URLs
  don't accept a custom alarm.
- **Auto-cancel** — when a journey closes, `cancelUpcomingMeetings()` marks
  every future meeting cancelled *in the app* immediately (that part really
  is fully automatic — Insights, the roster, and My Journey all reflect it
  with no user action). It also generates a `METHOD:CANCEL` `.ics` with the
  same `UID` and an incremented `SEQUENCE`, which is the correct way to
  cancel a calendar entry — but a person still has to open that file once to
  remove it from their real calendar.

**What this can't do on its own:** silently create, move, or delete an event
directly inside someone's actual Outlook/Google account with zero clicks —
that's the piece every one-click/"add to calendar" trick above can't reach,
and it's genuinely an OAuth + backend problem, not a JS problem:

1. Register an app with Microsoft Graph (`Calendars.ReadWrite`, delegated or
   an app-only permission against a service mailbox) and/or the Google
   Calendar API (OAuth2 client).
2. Stand up a small backend to hold refresh tokens per mentor/mentee (this
   can't live in browser `localStorage` — it's the same reason the AI data
   source above needs a proxy).
3. Swap `js/calendar.js`'s `buildICS`/link-builders for real API calls:
   `POST /users/{id}/events` (Graph) or `events.insert` (Google) to create —
   both support `sendUpdates`/attendee notifications, so the invite email is
   sent automatically, no `.ics` click required. `PATCH`/`DELETE` the same
   event to update or cancel it — again, delivered automatically.
4. To react the instant a relationship ends rather than only front-end side:
   trigger that same `DELETE` call server-side from wherever `formalStatus`
   flips to `closed` (a webhook from this app's backend once it has one, or
   a scheduled reconciliation job). Graph and Google Calendar also both
   support change-notification webhooks if you need the reverse — reacting
   when someone edits/declines an event in their own calendar.

That's the shape of the "challenge at work" this feature is aimed at: the
scheduling/reminder UX can be solved today (this app does it), but silent,
bidirectional sync needs the OAuth + backend piece above regardless of what
frontend sits in front of it.

## Plugging in real employee data

Click **Data source** in the header. Point it at any REST endpoint that
returns:

```json
{ "employees": [ { "id": "...", "fullName": "...", "displayName": "...",
  "department": "...", "geography": "...", "learningGoals": ["..."],
  "offeredSkills": ["..."], "preferredFormat": "mentor|mentee|peer|reverse",
  "engagementStatus": "available|active|paused|closed", "rating": 4.8,
  "menteeCount": 3 } ] }
```

Field names match `js/data.js` — the rest of the app needs no changes if your
API returns them as-is. The key is stored in `localStorage` and sent as
`Authorization: Bearer <key>` (see `js/api.js`).

**Before deploying this beyond a local prototype:** don't ship a real API key
in client-side code. Put a small backend/proxy in front of your employee-data
API so the key never reaches the browser, and point `endpoint` at that proxy
instead.

## Files

- `index.html` — markup for all 5 tabs + 9 modals
- `css/styles.css` — RateGain "Pop Purple" palette (Manrope, `#8012FF` /
  `#401E86`) extracted from the source deck — no separate brand-kit file
  existed on disk, so these are the values actually used there
- `js/data.js` — mock roster + program constants (stages, KPI targets,
  match weights, decision gates, resources) sourced from the deck/SOP
- `js/matching.js` — the weighted match-scoring engine
- `js/api.js` — pluggable AI/HRIS data-source adapter
- `js/calendar.js` — `.ics` generation, Google/Outlook quick-add links,
  cancellation builder, and the nudge `mailto:` composer
- `js/app.js` — all UI logic, state, and persistence
- `assets/logo.svg` — the GainForward mark (also used as the favicon)
- `docs/GainForward Participant Questionnaire.md` — the profile-setup
  questionnaire mentors and mentees complete; the onboarding form and "My
  profile" screen are built directly from these fields
