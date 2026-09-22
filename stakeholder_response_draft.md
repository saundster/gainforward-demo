Subject: Re: Feedback on the mentorship platform prototype

Hi both,

Thank you both for the thorough testing and feedback — this was exactly the kind of hands-on pass that surfaces real friction, and I've gone through every point below. Most of it is fixed and live now; a couple of things are genuine integration work we're actively pushing on rather than something a UI change alone can solve, and I've called those out separately. The demo link is unchanged throughout, so no new bookmark needed.

**Branding.** Agreed — we don't want two tools in the same ecosystem with overlapping names. The app is now called Ripple, renamed everywhere: the app itself, demo accounts, calendar invites, exported reports, and the docs. The idea behind it: one conversation creating an effect that outlasts it, which felt closer to what this program is actually trying to do. Flag it if "Ripple" collides with anything else out there and we'll revisit.

**Topic for the first conversation.** Fixed — it's optional now, along with the "what have you tried" field. Good catch that requiring it up front could be a barrier before people even know what they want to discuss.

**The match-screen error.** Found it, and it's directly tied to the point above: the "error" was the app blocking you because that topic field was required. Not a bug so much as a bad default — now that it's optional, that screen shouldn't stop anyone. Since this was blocking most of the testing for both mentor1 and mentee1, I'd really appreciate a second pass now that it's unblocked.

**Timezones when scheduling.** Fixed. The scheduling form now shows your own timezone next to the time picker, and once a date/time is picked it also shows the equivalent local time for the other person, based on whatever timezone they've set in their profile.

**Calendar integration.** This is the one still in progress, not something I could patch into the prototype directly — it needs OAuth into Google/Outlook and a backend to hold tokens and run free/busy lookups, which a static, no-backend prototype can't do on its own. The good news is it's already moving: we're actively working through this with SRE and IT, and the flow and integration on our end are ready and waiting on their go-ahead to turn on real sync. I'll loop you both in as soon as that's greenlit so you can test the real thing instead of today's placeholder. Completely agree this is the difference between people actually adopting the tool versus working around it, so it's a priority, not an afterthought.

**Calendar invite missing the other participant and a video link.** Fixed. You can now add a video call link when scheduling (Zoom, Meet, Teams, whatever's in use), and the generated invite — Google, Outlook, or the downloaded .ics — includes both participants as attendees plus that link.

**Steps should drop off once completed, and it should be clear which step a pair is on.** Fixed, per exactly what you described: Connect and Transfer now only appear as options if that pair hasn't already used them, so no pair ends up with two "Connect" entries or a second "Transfer." Goal, Challenge, and Apply stay available to log or schedule more than once, since those often take more than one sitting. On the related question of whether we should allow multiple meetings per stage at all, or lock this down to a strict 5-meeting process: I went with the reading above as my own judgment call, since Goal/Challenge/Apply seem genuinely likely to need more than one sitting for a lot of pairs — but this is a real open policy question, not something I should just decide unilaterally, so let me know if you'd rather we enforce a strict 5-meeting-total model and I'll adjust.

**Manually entering name, department, and region when signing up as a mentor.** This one's actually already handled — for every real account, those fields are pulled in automatically from the person's profile and shown as read-only; there's no way to edit them. The only place you'd see them as editable blank fields is on a brand-new, unprovisioned demo profile (newuser1), which is likely what was tested. If either of you saw them editable on a real demo account, tell me which one, because that would be a genuine bug.

**Region list.** Done — collapsed to APAC / EMEA / Americas, no separate LATAM/NA split, and (per the point above) it's auto-filled from the person's profile rather than picked at sign-up.

**Skill category — only one selectable.** Fixed. Both "what I want to learn" and "what I can offer/mentor" now let you check as many categories as apply, and matching now credits a shared category on either side rather than requiring one exact match — so someone mentoring across categories won't get penalized for it.

**Dashboard unclear on next steps after signing up.** Fixed. Previously the only feedback after finishing mentor or mentee sign-up was a toast that disappears. The Home dashboard's "Active Journey" card now gives a persistent, role-aware next step instead — for example, pointing a mentor toward finding a mentee (it previously said "Find a mentor" even for someone who'd just become a mentor, which wasn't just unclear, it was backwards).

**Not clear if you're the mentor or mentee in a pairing.** Fixed. Home and My Journey now say "You're mentoring [name]" or "You're being mentored by [name]" instead of a neutral "With [name]."

**Goal — what's supposed to happen, and is anything supposed to be added to the system?** This surfaced a real gap: the notes field when logging a conversation was one generic placeholder for every stage, so there was nothing prompting you toward what "Goal" actually means. It's now stage-specific — Goal explicitly asks "What did you agree as the learning/contribution goal for this relationship?" To answer the underlying question directly: this is a guided conversation tracker, not a separate structured goal-setting tool — the point of the new prompt is to make that expectation clear in the moment rather than leaving people staring at a blank "notes" box wondering if something else was supposed to appear.

**Midpoint pulse check not visible in the timeline.** Fixed — added a "Midpoint pulse check unlocks after this" marker directly on the stage tracker, since before it only lived further down the page and was easy to miss.

**Mentee2 — meetings seemed to auto-populate a stage, no visible place for comments.** Found a real bug here: the "Log a session" stage picker wasn't defaulting intelligently at all, so it silently pre-selected whichever stage happened to render first in the list rather than the actual next stage — which is almost certainly what looked like an unexplained "auto-populate." It now defaults correctly, the same way "Schedule a conversation" already did. The notes field itself was already there; it should be much more discoverable now that the right stage is selected and prompting the right question.

**"NA" on the region picker — North America or Not Applicable?** Fair, and already resolved by the region simplification above — it's "Americas" now, spelled out, not an abbreviation.

**Signing up as both a mentor and a mentee.** That's intentional, not a bug — someone can hold both roles at the same time.

**One more small thing, unprompted:** the "send a nudge" email disclosure line was more convoluted than it needed to be, so I tightened it to "This opens a draft in your own email app, addressed to them. Nothing is sent until you hit send there."

Since the mandatory-topic bug was blocking most of the flow early on, a fresh end-to-end pass would be genuinely useful whenever you both have time — especially scheduling (timezone hint + video link), multi-category matching, and the stage/role clarity changes. And flag anything that still doesn't add up; happy to keep iterating.

Thanks again for digging in as deep as you did — this kind of feedback is exactly what makes the prototype better before it's real.

Tarun
