# Ripple — Backend & Database Scoping

Companion to `Ripple-Deployment-Requirements-Checklist-FILLED.docx`. That doc
established *what's missing*; this one proposes *what to build*, grounded in
a full read of the current client-side data model (every field, every
relationship — see `js/data.js` / `js/app.js`), not a rewrite from scratch.

---

## 1. The one decision that gates everything else

The filled checklist already tells us the **end state**: internal-only,
VPN-accessible, on a dedicated `xyz.rategain.com` subdomain. That already
rules out "just keep it on public Vercel forever." The open question is
**who operates it and in what stack** — and that's an Infra call, not
mine to make unilaterally. Two real options:

| | Option A — Node/Express + Postgres | Option B — Java/Spring Boot + Postgres |
|---|---|---|
| Why | Same language as the existing frontend; no stack-switch for whoever maintains this next | Matches the stack Infra's own checklist questions assume (Spring Boot, Maven/Gradle, JVM version) — likely their standard, supported, monitored stack |
| Container/K8s/EC2 compatible | Yes | Yes |
| SSO libraries (SAML/OIDC) | Mature (`passport-saml`, `openid-client`) | Mature (Spring Security SAML/OAuth2) |
| Risk | Infra may not have Node runbooks/monitoring conventions | More build time if nobody on this side knows Java |

**Recommendation: Option A**, specifically because it's the smaller
total-cost path — but this should be confirmed with Infra in the same
conversation where Kubernetes-vs-EC2 gets decided, since the "Next Steps"
section of the checklist already says that platform choice depends on
Section 1's answers.

---

## 2. Database schema (PostgreSQL)

Derived directly from the current `Employee`/`Journey` shapes — every field
below has a 1:1 source in `js/data.js` or `js/app.js`, nothing invented.

```sql
-- People. "division" is dropped: every save path in the current app sets
-- division = department anyway, so it's not an independent field.
CREATE TABLE users (
  id                    TEXT PRIMARY KEY,          -- keep string IDs (e.g. Darwinbox employee id)
  full_name             TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  avatar_initials       TEXT,
  photo_url             TEXT,                      -- becomes a real object-storage URL, not a data: URL
  email                 TEXT UNIQUE NOT NULL,
  department            TEXT,
  career_level          TEXT,
  tenure_band           TEXT,
  geography             TEXT,
  learning_goals        TEXT[] DEFAULT '{}',        -- max 3, enforced at API layer
  learning_skill_category TEXT[] DEFAULT '{}',
  offered_skills        TEXT[] DEFAULT '{}',         -- max 5, enforced at API layer
  mentor_skill_category  TEXT[] DEFAULT '{}',
  mentee_capacity       INT,
  experience             TEXT,
  goal_statement         TEXT,
  purpose                TEXT,
  interests              TEXT[] DEFAULT '{}',
  preferred_format       TEXT,                       -- mentor | mentee | peer | reverse
  is_mentor              BOOLEAN NOT NULL DEFAULT false,
  is_mentee              BOOLEAN NOT NULL DEFAULT false,
  delivery_format        TEXT,                       -- Virtual | In-person | Hybrid
  preferred_language     TEXT,
  skill_level            TEXT,
  ai_confidence          TEXT,
  availability_frequency TEXT,
  availability_hours     INT,
  availability_timezone  TEXT,
  availability_windows   TEXT,
  match_note             TEXT,
  engagement_status      TEXT NOT NULL DEFAULT 'available', -- available|active|paused|closed
  consent_ack            BOOLEAN NOT NULL DEFAULT false,
  profile_complete       BOOLEAN NOT NULL DEFAULT false,
  admin_role             TEXT,                       -- admin | superadmin | null
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
  -- NOTE: no `rating` or `mentee_count` columns — see §3, computed instead.
);

CREATE TABLE journeys (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_a_id    TEXT NOT NULL REFERENCES users(id),
  participant_b_id    TEXT NOT NULL REFERENCES users(id),
  role_of_a           TEXT NOT NULL,                 -- mentor|mentee|peer|reverse
  role_of_b           TEXT NOT NULL,
  relationship_type   TEXT NOT NULL,                 -- 1:1 Mentoring | Peer Learning | Reverse Mentoring
  formal_status       TEXT NOT NULL DEFAULT 'active', -- active | closed
  start_date          DATE NOT NULL,
  paused_at           DATE,
  paused_days         INT NOT NULL DEFAULT 0,
  prep_topic          TEXT,
  prep_note           TEXT,
  prep_note_from_id   TEXT REFERENCES users(id),
  shared_goal_text     TEXT,                          -- sharedGoal flattened: 0-or-1 per journey
  shared_goal_set_by   TEXT REFERENCES users(id),
  shared_goal_set_at   DATE,
  outcome             TEXT,                           -- rematch|end|contributor|continue|NULL
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE journey_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id   UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  stage        TEXT NOT NULL,                        -- connect|goal|challenge|apply|transfer
  session_date DATE NOT NULL,
  notes        TEXT,
  logged_by    TEXT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meetings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id      UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  ics_uid         TEXT NOT NULL,
  stage           TEXT NOT NULL,
  start_at        TIMESTAMPTZ NOT NULL,
  duration_mins   INT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled|completed|cancelled
  sequence        INT NOT NULL DEFAULT 0,
  organizer_id    TEXT NOT NULL REFERENCES users(id),
  meeting_link    TEXT,
  agenda_topic    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- pulse/reflection are 1-per-participant-per-journey maps today; model as
-- proper rows with a uniqueness constraint instead of a JSON blob keyed by id.
CREATE TABLE journey_pulse_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id     UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES users(id),
  q1 INT, q2 INT, q3 INT, q4 INT,                     -- Likert values — confirm actual scale with product owner
  continuation   TEXT,
  open_text      TEXT,
  submitted_at   DATE NOT NULL,
  UNIQUE (journey_id, participant_id)
);

CREATE TABLE journey_reflections (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id             UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  participant_id         TEXT NOT NULL REFERENCES users(id),
  set_out_to_learn       TEXT,
  what_learned           TEXT,
  what_partner_learned   TEXT,
  applied_in_workplace   BOOLEAN,
  would_continue         TEXT,
  would_recommend        TEXT,
  what_to_change         TEXT,
  next_step              TEXT,                        -- continue|end|contributor
  submitted_at           DATE NOT NULL,
  UNIQUE (journey_id, participant_id)
);

CREATE TABLE action_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id  UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  done        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pinned_resources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id  UUID NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  added_by    TEXT NOT NULL REFERENCES users(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Real pending/accept/decline lifecycle (see §3 — current app has no such
-- thing; recommending we build it properly rather than port the gap forward).
CREATE TABLE connection_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id     TEXT NOT NULL REFERENCES users(id),
  to_id       TEXT NOT NULL REFERENCES users(id),
  score       NUMERIC,
  breakdown   JSONB,
  status      TEXT NOT NULL DEFAULT 'pending',        -- pending|accepted|declined
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ
);

CREATE TABLE nudges (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id   TEXT NOT NULL REFERENCES users(id),
  to_id     TEXT NOT NULL REFERENCES users(id),
  message   TEXT NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   TEXT NOT NULL REFERENCES users(id),      -- normalized: was a denormalized name string client-side
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Reference/config data** (program stages, KPI targets, match weights,
learning-content library, skill categories) stays as versioned app config
(code or a config file), not database tables — it changes rarely, isn't
per-user, and turning it into editable DB content is a separate, later
decision if non-engineers need to update it directly.

---

## 3. Three things the schema fixes rather than ports forward

The data-model audit turned up three places where the current client-side
app has an unfinished or inconsistent behavior. Rather than faithfully
reproduce these gaps in the real backend, the schema above already resolves
them — flagging so this is a deliberate choice, not something slipped in:

1. **Connection requests are instant-accept today** — `status` is only
   ever written as `"accepted"`; there's no real pending → accept/decline
   flow despite the field existing. The real backend adds a proper
   `pending`/`accepted`/`declined` lifecycle (table above already reflects
   this) — worth confirming this is actually the desired product behavior
   before building it.
2. **`rating` and `menteeCount` have no real write path** — `menteeCount`
   increments but never decrements, `rating` is seed-data-only. Recommend
   computing both as live aggregates (`COUNT(*) FROM journeys WHERE ...`,
   `AVG(...)` from a future ratings table) rather than persisted counters
   that can drift out of sync — the exact class of bug already found and
   fixed once this session (`engagementStatus` drift).
3. **`division` always equals `department`** in every save path today —
   dropped as a separate column above rather than carried forward as dead
   weight.

---

## 4. Auth — the actual open question

Darwinbox is confirmed as the source of identity, and the API key is in
hand — but that key is for Darwinbox's **employee-data API** ("masterapi"),
which is a completely different thing from **SSO login**. Before any auth
code gets written, this needs a direct answer from whoever administers
Darwinbox: **does Darwinbox itself support acting as a SAML/OIDC identity
provider**, or is the intended login flow actually through Azure AD /
another IdP (with Darwinbox staying purely a data source for roster sync)?
The original checklist template's own "Already Confirmed" section lists
"SSO — DarwinBox integration," which reads as intending Darwinbox for
login too — but that needs to be verified against Darwinbox's actual
product capability, not assumed.

---

## 5. Phased plan

1. **Confirm stack + hosting + SSO capability** (this section + §1 — Infra
   + whoever owns the Darwinbox relationship).
2. **Stand up schema + a thin CRUD API**, migrate the seeded demo dataset
   into real rows, swap the frontend's `localStorage` read/writes for
   `fetch()` calls. This is more contained than it sounds — the app
   already funnels every persisted mutation through one small set of
   functions keyed by the `STORAGE` map (`js/app.js`), so the surface
   area to change is narrow, not a rewrite.
3. **Real authentication** replacing the hardcoded demo-account password
   check, once §4 is answered.
4. **Darwinbox roster sync** — replace seed employees with real org data,
   finally verifying `api/employees.js`'s currently-unverified endpoint
   assumptions against a real response.
5. **CI, environments, observability, backup/DR** — everything Section
   7/8 of the deployment checklist flagged as nonexistent today.
6. **Pilot rollout** on a subset of the ~1400 users, per the checklist's
   own recommendation, before org-wide.

Steps 2–4 are real engineering work, not configuration — worth sizing
with whoever ends up building it once §1 and §4 are answered.
