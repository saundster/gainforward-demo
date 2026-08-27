/* GainForward — app logic (tabs, forms, matching, journeys, insights, admin). */

const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STORAGE = {
  requests: "gainforward.requests",
  journeys: "gainforward.journeys",
  gates: "gainforward.gateStatus",
  addedEmployees: "gainforward.addedEmployees",
  overrides: "gainforward.employeeOverrides",
  nudges: "gainforward.nudges",
  activeDemoUser: "gainforward.activeDemoUser",
};

let CURRENT_USER_ID = null;
let employees = [];
let requests = loadPersisted(STORAGE.requests, []);
let journeys = loadPersisted(STORAGE.journeys, null); // null = not yet seeded this browser
let gateStatus = loadPersisted(STORAGE.gates, {});
let nudges = loadPersisted(STORAGE.nudges, []);
let dataSourceInfo = { source: "seed" };

function loadPersisted(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function savePersisted(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function pct(n) {
  return `${Math.round(clamp(n, 0, 1) * 100)}%`;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d;
}
function formatDateShort(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function daysBetween(fromStr, toDate) {
  const from = new Date(`${fromStr}T00:00:00`);
  return Math.floor((toDate - from) / (1000 * 60 * 60 * 24));
}
/** Real calendar window for a stage, given the journey's own start date — not a generic template. */
function stageDateRange(startDateStr, stage) {
  const from = addDays(startDateStr, (stage.weekStart - 1) * 7);
  const to = addDays(startDateStr, stage.weekEnd * 7 - 1);
  return `${formatDateShort(from)} – ${formatDateShort(to)}`;
}
function weekNumberFor(startDateStr) {
  return clamp(Math.floor(daysBetween(startDateStr, new Date()) / 7) + 1, 1, 12);
}
function pilotEndDate(startDateStr) {
  return formatDateShort(addDays(startDateStr, 12 * 7));
}
function daysAgoLabel(dateStr) {
  const days = daysBetween(dateStr, new Date());
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return formatDateShort(new Date(`${dateStr}T00:00:00`));
}

const STATUS_LABELS = {
  available: "Open to connect",
  active: "Currently in a journey",
  paused: "Paused",
  closed: "Not accepting requests",
};
function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function scoreVerdict(score) {
  if (score >= 75) return "Strong potential match";
  if (score >= 55) return "Worth exploring";
  return "Possible, but a stretch";
}

function greetingPrefix() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function getEmployeeById(id) {
  return employees.find((e) => e.id === id);
}
function getCurrentUser() {
  return getEmployeeById(CURRENT_USER_ID) || employees[0];
}
function isJourneyOpen(j) {
  return j.formalStatus !== "closed";
}
function findActiveJourneyFor(userId) {
  return journeys.find((j) => isJourneyOpen(j) && (j.participantA === userId || j.participantB === userId));
}
function getPartnerId(journey, userId) {
  return journey.participantA === userId ? journey.participantB : journey.participantA;
}

/* ---------------------------------------------------------------- */
/* Toasts                                                            */
/* ---------------------------------------------------------------- */
function toast(message, type = "") {
  const region = $("#toast-region");
  const el = document.createElement("div");
  el.className = `toast${type ? ` toast--${type}` : ""}`;
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/* ---------------------------------------------------------------- */
/* Modals                                                             */
/* ---------------------------------------------------------------- */
function openModal(id) {
  $("#modal-backdrop").classList.remove("hidden");
  $(`#${id}`).classList.remove("hidden");
}
let isOnboarding = false;
function closeAllModals(force) {
  if (isOnboarding && !force) return;
  $("#modal-backdrop").classList.add("hidden");
  $all(".modal").forEach((m) => m.classList.add("hidden"));
}

/** Same form serves two purposes: mandatory first-run onboarding, and later profile edits. */
function openProfileModal({ onboarding }) {
  isOnboarding = onboarding;
  const me = getCurrentUser();
  const form = $("#form-become-mentor");
  form.fullName.value = me.fullName || "";
  form.email.value = me.email || "";
  form.department.value = me.department || "";
  if (me.geography) form.geography.value = me.geography;
  form.learningGoals.value = (me.learningGoals || []).join(", ");
  form.learningSkillCategory.value = me.learningSkillCategory || "";
  form.skillLevel.value = me.skillLevel || "";
  form.offeredSkills.value = (me.offeredSkills || []).join(", ");
  form.mentorSkillCategory.value = me.mentorSkillCategory || "";
  form.goalStatement.value = me.goalStatement || "";
  form.purpose.value = me.purpose || "";
  if (me.preferredFormat) form.preferredFormat.value = me.preferredFormat;
  if (me.aiConfidence) form.aiConfidence.value = me.aiConfidence;
  if (me.availability?.frequency) form.frequency.value = me.availability.frequency;
  form.timezone.value = me.availability?.timezone || "";
  form.matchNote.value = me.matchNote || "";
  form.consentAck.checked = !!me.consentAck;

  // Sign-up builds the full profile in one go — this is the only place all of
  // this is asked, so there's nothing left to fill in piecemeal later.
  $("#profile-modal-title").textContent = onboarding ? "Welcome to GainForward — let's build your profile" : "Your profile";
  $("#profile-modal-intro").textContent = onboarding
    ? "This is what powers your matches — about 5–7 minutes."
    : "Update what you're learning, offering, and how you'd like to participate.";
  $("#profile-modal-close").classList.toggle("hidden", onboarding);
  $("#profile-modal-cancel").classList.toggle("hidden", onboarding);
  $("#profile-modal-submit").textContent = onboarding ? "Create my profile" : "Save changes";

  openModal("modal-become-mentor");
}

function renderUserChrome() {
  const me = getCurrentUser();
  $("#user-avatar-btn").textContent = me.avatarInitials || "?";
  $("#dropdown-avatar").textContent = me.avatarInitials || "?";
  $("#dropdown-name").textContent = me.fullName || "Your name";
  $("#dropdown-role").textContent = me.profileComplete ? `${me.department || "—"} · ${me.geography || "—"}` : "Profile not set up yet";
}

/** Focused add-on forms — layered on top of whatever base profile onboarding already collected. */
function openBecomeMentorRoleModal() {
  const me = getCurrentUser();
  const form = $("#form-become-mentor-role");
  form.fullName.value = me.fullName || "";
  form.email.value = me.email || "";
  form.department.value = me.department || "";
  if (me.geography) form.geography.value = me.geography;
  form.purpose.value = me.purpose || "";
  if (me.mentorSkillCategory) form.mentorSkillCategory.value = me.mentorSkillCategory;
  form.offeredSkills.value = (me.offeredSkills || []).join(", ");
  if (me.availability?.frequency) form.frequency.value = me.availability.frequency;
  form.timezone.value = me.availability?.timezone || "";
  form.consentAck.checked = !!me.consentAck;
  openModal("modal-become-mentor-role");
}

function openBecomeMenteeRoleModal() {
  const me = getCurrentUser();
  const form = $("#form-become-mentee-role");
  form.fullName.value = me.fullName || "";
  form.email.value = me.email || "";
  form.department.value = me.department || "";
  if (me.geography) form.geography.value = me.geography;
  form.learningGoals.value = (me.learningGoals || []).join(", ");
  if (me.learningSkillCategory) form.learningSkillCategory.value = me.learningSkillCategory;
  if (me.skillLevel) form.skillLevel.value = me.skillLevel;
  if (me.availability?.frequency) form.frequency.value = me.availability.frequency;
  form.timezone.value = me.availability?.timezone || "";
  form.goalStatement.value = me.goalStatement || "";
  form.consentAck.checked = !!me.consentAck;
  openModal("modal-become-mentee-role");
}

/* ---------------------------------------------------------------- */
/* Tabs                                                               */
/* ---------------------------------------------------------------- */
function switchTab(tab) {
  $all(".tab-btn").forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", String(active));
    if (active) b.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  $all(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${tab}`));
  if (tab === "directory") renderDirectory();
  if (tab === "journey") renderJourney();
  if (tab === "insights") renderInsights();
  if (tab === "admin") renderAdmin();
}

/* ---------------------------------------------------------------- */
/* Home                                                               */
/* ---------------------------------------------------------------- */
function renderHome() {
  const me = getCurrentUser();
  const firstName = me.fullName && me.fullName !== "You" ? me.fullName.split(" ")[0] : "";
  $("#home-greeting").textContent = firstName ? `${greetingPrefix()}, ${firstName}. What would you like to do?` : "What would you like to do?";
  renderTopMentors();
  renderActiveJourneyCard();
  renderGrowthProfileCard();
}

function renderTopMentors() {
  const list = $("#top-mentors-list");
  const me = getCurrentUser();
  const mentors = employees
    .filter((e) => e.id !== CURRENT_USER_ID && e.preferredFormat === "mentor")
    .map((e) => ({ employee: e, score: computeMatchScore(me, e).total }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  if (!mentors.length) {
    list.innerHTML = `<p class="empty-state">No mentors available yet.</p>`;
    return;
  }

  list.innerHTML = mentors
    .map(
      ({ employee: m }) => `
    <div class="mentor-row">
      <div class="avatar">${m.avatarInitials}</div>
      <div class="mentor-row-info">
        <div class="mentor-row-name">${m.displayName}</div>
        <div class="mentor-row-meta">${m.department} · ${m.geography} · ${m.menteeCount} mentee${m.menteeCount === 1 ? "" : "s"}</div>
      </div>
      ${m.rating ? `<div class="rating">★ ${m.rating.toFixed(1)}</div>` : ""}
      <button class="btn btn-secondary btn-sm" data-action="request-mentor" data-id="${m.id}">View match</button>
    </div>`
    )
    .join("");
}

function getJourneyStartDate(journey) {
  return journey.startDate || journey.sessions[0]?.date || new Date().toISOString().slice(0, 10);
}

function renderActiveJourneyCard() {
  const card = $("#active-journey-card");
  const journey = findActiveJourneyFor(CURRENT_USER_ID);
  if (!journey) {
    card.innerHTML = `
      <p class="muted small">No active journey yet — start one from the Directory or by becoming a mentor.</p>
      <button class="btn btn-primary btn-sm" data-action="goto-directory">Find a mentor</button>`;
    return;
  }
  const partner = getEmployeeById(getPartnerId(journey, CURRENT_USER_ID));
  const completed = journey.sessions.filter((s) => s.completed).length;
  const progress = clamp(completed / 5, 0, 1);
  const stageIndex = clamp(completed, 0, PROGRAM_META.stages.length - 1);
  const stage = PROGRAM_META.stages[stageIndex];
  const startDate = getJourneyStartDate(journey);
  const weekNumber = weekNumberFor(startDate);
  const lastSession = journey.sessions.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
  const upcomingMeeting = (journey.meetings || [])
    .filter((m) => m.status === "scheduled" && new Date(m.startISO) > new Date())
    .sort((a, b) => a.startISO.localeCompare(b.startISO))[0];

  const nextAction = upcomingMeeting
    ? `Scheduled: ${meetingTimeLabel(upcomingMeeting.startISO)}`
    : completed === 0
    ? `Schedule your first conversation — ${stage.label.toLowerCase()} is up first.`
    : completed >= 5
    ? journey.reflection
      ? "All five conversations logged — reflection submitted."
      : "All five conversations logged — complete your final reflection."
    : `Next up: your ${stage.label.toLowerCase()} conversation — nothing on the calendar yet.`;

  card.innerHTML = `
    <div class="journey-summary">
      <div>
        <div class="journey-partner">With ${partner ? partner.displayName : "—"}</div>
        <div class="journey-type">${journey.relationshipType} · Week ${weekNumber} of 12</div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct(progress)}"></div></div>
      <div class="progress-label"><span>${completed} of 5 conversations</span><span>${pct(progress)}</span></div>
      ${lastSession ? `<div class="muted small">Last session: ${daysAgoLabel(lastSession.date)}</div>` : ""}
      <div class="next-action">${nextAction}</div>
      <button class="btn btn-secondary btn-sm" data-action="goto-journey">Go to My Journey</button>
    </div>`;
}

function renderGrowthProfileCard() {
  const card = $("#growth-profile-card");
  const me = getCurrentUser();
  const journey = findActiveJourneyFor(CURRENT_USER_ID);
  const completed = journey ? journey.sessions.filter((s) => s.completed).length : 0;
  const progress = journey ? clamp(completed / 5, 0, 1) : 0;
  const hasProfile = (me.learningGoals && me.learningGoals.length) || (me.offeredSkills && me.offeredSkills.length);

  if (!hasProfile) {
    card.innerHTML = `
      <p class="muted small">You haven't shared what you want to learn or can offer yet — that's what powers your match scores.</p>
      <div class="row-actions">
        <button class="btn btn-secondary btn-sm" data-action="open-become-mentor-role">Become a mentor</button>
        <button class="btn btn-secondary btn-sm" data-action="open-become-mentee-role">Become a mentee</button>
      </div>`;
    return;
  }

  card.innerHTML = `
    ${me.learningGoals?.length ? `<div class="growth-row"><span class="growth-label">Learning</span><span class="growth-value">${me.learningGoals.join(", ")}</span></div>` : ""}
    ${me.skillLevel ? `<div class="growth-row"><span class="growth-label">Skill level</span><span class="growth-value">${me.skillLevel}</span></div>` : ""}
    ${me.goalStatement ? `<div class="growth-row"><span class="growth-label">Goal</span><span class="growth-value">${me.goalStatement}</span></div>` : ""}
    ${me.offeredSkills?.length ? `<div class="growth-row"><span class="growth-label">Offering</span><span class="growth-value">${me.offeredSkills.join(", ")}</span></div>` : ""}
    ${me.purpose ? `<div class="growth-row"><span class="growth-label">Why I mentor</span><span class="growth-value">${me.purpose}</span></div>` : ""}
    ${
      journey
        ? `<div style="margin-top:10px">
      <div class="progress-track"><div class="progress-fill" style="width:${pct(progress)}"></div></div>
      <div class="progress-label"><span>Journey progress</span><span>${pct(progress)}</span></div>
    </div>`
        : `<p class="muted small" style="margin-top:10px">No active journey yet — your progress will track here once you're matched.</p>`
    }`;
}

/* ---------------------------------------------------------------- */
/* Directory                                                          */
/* ---------------------------------------------------------------- */
function populateFilterDropdowns() {
  const depts = [...new Set(employees.map((e) => e.department))].sort();
  const geos = [...new Set(employees.map((e) => e.geography))].sort();
  const deptSel = $("#filter-department");
  const geoSel = $("#filter-geo");
  deptSel.innerHTML = `<option value="">All departments</option>` + depts.map((d) => `<option value="${d}">${d}</option>`).join("");
  geoSel.innerHTML = `<option value="">All regions</option>` + geos.map((g) => `<option value="${g}">${g}</option>`).join("");
}

function renderDirectory() {
  const search = $("#directory-search").value.trim().toLowerCase();
  const dept = $("#filter-department").value;
  const geo = $("#filter-geo").value;
  const format = $("#filter-format").value;

  const results = employees.filter((e) => {
    if (e.id === CURRENT_USER_ID) return false;
    if (dept && e.department !== dept) return false;
    if (geo && e.geography !== geo) return false;
    if (format && e.preferredFormat !== format) return false;
    if (search) {
      const haystack = [e.fullName, ...(e.learningGoals || []), ...(e.offeredSkills || [])].join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  const grid = $("#directory-grid");
  if (!results.length) {
    grid.innerHTML = `<p class="empty-state">No one matches those filters yet.</p>`;
    return;
  }

  grid.innerHTML = results
    .map((e) => {
      const existing = requests.find((r) => r.fromId === CURRENT_USER_ID && r.toId === e.id && r.status !== "declined");
      const skillsChips = (e.offeredSkills && e.offeredSkills.length ? e.offeredSkills : e.learningGoals || [])
        .slice(0, 4)
        .map((s) => `<span class="chip">${s}</span>`)
        .join("");
      return `
      <div class="employee-card">
        <div class="employee-card-head">
          <div class="avatar">${e.avatarInitials}</div>
          <div>
            <div class="employee-name">${e.displayName}</div>
            <div class="employee-meta">${e.department} · ${e.geography}</div>
          </div>
        </div>
        <div class="chip-row">
          <span class="chip chip--status chip--${e.engagementStatus}">${statusLabel(e.engagementStatus)}</span>
          <span class="chip">${formatLabel(e.preferredFormat)}</span>
          ${e.rating ? `<span class="chip">★ ${e.rating.toFixed(1)} · ${e.menteeCount} mentees</span>` : ""}
        </div>
        <div class="chip-row">${skillsChips}</div>
        <div class="employee-card-footer">
          <button class="btn btn-secondary btn-sm" data-action="request-mentor" data-id="${e.id}">
            ${existing ? "View connection" : "View match & connect"}
          </button>
        </div>
      </div>`;
    })
    .join("");
}

function formatLabel(format) {
  return { mentor: "Mentor", mentee: "Mentee", peer: "Peer", reverse: "Reverse mentoring" }[format] || format;
}

/* ---------------------------------------------------------------- */
/* Match modal + requests                                             */
/* ---------------------------------------------------------------- */
let matchModalTargetId = null;

function openMatchModalFor(candidateId) {
  const me = getCurrentUser();
  const candidate = getEmployeeById(candidateId);
  if (!candidate) return;
  matchModalTargetId = candidateId;

  const { total, breakdown } = computeMatchScore(me, candidate);
  const reasons = matchReasons(me, candidate, breakdown);
  const existing = requests.find((r) => r.fromId === CURRENT_USER_ID && r.toId === candidateId && r.status !== "declined");
  const candidateBusy = findActiveJourneyFor(candidateId);
  const meBusy = findActiveJourneyFor(CURRENT_USER_ID);

  const body = $("#match-modal-body");
  body.innerHTML = `
    <div class="mentor-row" style="margin-bottom:4px">
      <div class="avatar">${candidate.avatarInitials}</div>
      <div class="mentor-row-info">
        <div class="mentor-row-name">${candidate.displayName}</div>
        <div class="mentor-row-meta">${candidate.department} · ${candidate.geography} · ${formatLabel(candidate.preferredFormat)}</div>
      </div>
    </div>
    <p class="match-verdict">${scoreVerdict(total)}</p>
    <p class="muted small" style="margin:2px 0 -2px">Why we think so:</p>
    <ul class="tip-list">${reasons.map((r) => `<li>${r}</li>`).join("")}</ul>
    <details class="score-details">
      <summary>Score breakdown (${total}%)</summary>
      <div class="bar-chart" style="margin-top:10px">
        ${breakdown
          .map(
            (b) => `
          <div class="bar-row">
            <span>${b.label}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${pct(b.score)}"></div></div>
            <span>${pct(b.score)}</span>
          </div>`
          )
          .join("")}
      </div>
    </details>
    ${
      existing
        ? `<p class="muted small">You're already connected — head to My Journey to get started.</p>`
        : meBusy
        ? `<p class="muted small">You already have an active journey — you'll need a rematch before starting a new one.</p>`
        : candidateBusy
        ? `<p class="muted small">${candidate.displayName} already has an active journey right now.</p>`
        : `<button class="btn btn-primary" id="btn-send-request">Connect now</button>
           <p class="muted small" style="margin-top:6px">This connects you right away — no approval needed. People Development can review it anytime and step in if something looks off.</p>`
    }
  `;

  openModal("modal-match");
  const sendBtn = $("#btn-send-request");
  if (sendBtn) sendBtn.addEventListener("click", () => sendRequest(candidateId, total, breakdown));
}

/** Connections form immediately on request — no admin approval gate. Admin can
 * still review any active connection and end it (no-fault rematch) at any time;
 * that's the guardrail, not a pre-approval step. */
function sendRequest(candidateId, total, breakdown) {
  const candidate = getEmployeeById(candidateId);
  const me = getCurrentUser();

  const fromBusy = findActiveJourneyFor(CURRENT_USER_ID);
  const toBusy = findActiveJourneyFor(candidateId);
  if (fromBusy || toBusy) {
    const busyName = fromBusy ? me.displayName : candidate.displayName;
    toast(`${busyName} already has an active journey. They'd need a rematch first — this pilot runs one relationship at a time.`, "error");
    return;
  }

  const relationshipType =
    candidate.preferredFormat === "peer" ? "Peer Learning" : candidate.preferredFormat === "reverse" ? "Reverse Mentoring" : "1:1 Mentoring";

  const request = {
    id: uid("req"),
    fromId: CURRENT_USER_ID,
    toId: candidateId,
    score: total,
    breakdown,
    checklist: matchQualityAnswerDefaults(me, candidate),
    status: "accepted",
    createdAt: new Date().toISOString(),
  };
  requests.push(request);

  journeys.push({
    id: uid("j"),
    participantA: CURRENT_USER_ID,
    participantB: candidateId,
    relationshipType,
    formalStatus: "active",
    startDate: new Date().toISOString().slice(0, 10),
    sessions: [],
    meetings: [],
    pulse: null,
    reflection: null,
  });
  if (candidate.menteeCount != null) candidate.menteeCount += 1;

  savePersisted(STORAGE.requests, requests);
  savePersisted(STORAGE.journeys, journeys);
  toast(`You're connected with ${candidate.displayName} — head to My Journey to schedule your first conversation.`, "success");
  closeAllModals();
  renderDirectory();
  renderHome();
}

/* ---------------------------------------------------------------- */
/* My Journey                                                         */
/* ---------------------------------------------------------------- */
const OUTCOME_LABELS = {
  continue: "continue informally",
  end: "end the formal relationship",
  contributor: "become a peer-learning contributor",
};

function renderJourneyCleanup() {
  const cleanup = $("#journey-cleanup");
  const closedWithCancellations = journeys.filter(
    (j) => j.formalStatus === "closed" && (j.participantA === CURRENT_USER_ID || j.participantB === CURRENT_USER_ID) && (j.meetings || []).some((m) => m.status === "cancelled" && m.cancelIcs)
  );
  if (!closedWithCancellations.length) {
    cleanup.classList.add("hidden");
    return;
  }
  cleanup.classList.remove("hidden");
  const rows = closedWithCancellations.flatMap((j) => {
    const partner = getEmployeeById(getPartnerId(j, CURRENT_USER_ID));
    return j.meetings
      .filter((m) => m.status === "cancelled" && m.cancelIcs)
      .map((m) => {
        const stage = PROGRAM_META.stages.find((s) => s.key === m.stage);
        return `
        <div class="session-item">
          <div class="session-item-head"><span>${stage ? stage.label : m.stage} with ${partner ? partner.displayName : "your partner"}</span><span class="muted small">${meetingTimeLabel(m.startISO)}</span></div>
          <div class="session-item-notes">Cancelled — still needs to be cleared from your real calendar.</div>
          <div class="match-actions" style="margin-top:8px">
            <button class="btn btn-ghost btn-sm" data-action="download-cancel-ics" data-id="${m.id}">Download cancellation (.ics)</button>
          </div>
        </div>`;
      });
  });
  $("#journey-cleanup-list").innerHTML = rows.join("");
}

function renderJourney() {
  const journey = findActiveJourneyFor(CURRENT_USER_ID);
  const empty = $("#journey-empty");
  const content = $("#journey-content");

  if (!journey) {
    empty.classList.remove("hidden");
    content.classList.add("hidden");
    $("#journey-subtitle").textContent = "Once you're matched, your conversations and progress will show up here.";
    renderJourneyCleanup();
    return;
  }
  $("#journey-cleanup").classList.add("hidden");
  empty.classList.add("hidden");
  content.classList.remove("hidden");

  const partner = getEmployeeById(getPartnerId(journey, CURRENT_USER_ID));
  const startDate = getJourneyStartDate(journey);
  const completed = journey.sessions.filter((s) => s.completed).length;
  const currentIndex = clamp(completed, 0, PROGRAM_META.stages.length - 1);
  const weekNumber = weekNumberFor(startDate);

  $("#journey-subtitle").textContent = `With ${partner ? partner.displayName : "your partner"} · Week ${weekNumber} of 12 · started ${formatDateShort(
    new Date(`${startDate}T00:00:00`)
  )}, wraps up around ${pilotEndDate(startDate)}.`;

  renderUpcomingMeetings(journey);

  $("#stage-tracker").innerHTML = PROGRAM_META.stages
    .map((stage, i) => {
      const state = i < completed ? "is-complete" : i === currentIndex ? "is-current" : "";
      return `
      <div class="stage-step ${state}">
        <div class="stage-dot">${i < completed ? "✓" : i + 1}</div>
        <div class="stage-label">${stage.label}</div>
        <div class="stage-weeks">${stageDateRange(startDate, stage)}</div>
        <div class="stage-detail">${stage.detail}</div>
      </div>`;
    })
    .join("");

  const logList = $("#session-log-list");
  logList.innerHTML = journey.sessions.length
    ? journey.sessions
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(
          (s) => `
      <div class="session-item">
        <div class="session-item-head"><span>${PROGRAM_META.stages.find((st) => st.key === s.stage)?.label || s.stage}</span><span class="muted small">${daysAgoLabel(s.date)}</span></div>
        ${s.notes ? `<div class="session-item-notes">${s.notes}</div>` : ""}
      </div>`
        )
        .join("")
    : `<p class="empty-state">No sessions logged yet — log your first conversation once you've met.</p>`;

  const pulseEligible = completed >= 2;
  const pulseBtn = $("#btn-open-pulse");
  const pulseStatus = $("#pulse-status");
  if (journey.pulse) {
    pulseStatus.textContent = `Submitted${journey.pulse.submittedAt ? ` ${daysAgoLabel(journey.pulse.submittedAt)}` : ""}. You can update it any time.`;
    pulseBtn.textContent = "Update pulse check";
    pulseBtn.disabled = false;
  } else if (!pulseEligible) {
    pulseStatus.textContent = `Unlocks after your 2nd conversation — ${completed} of 2 logged so far.`;
    pulseBtn.textContent = "Complete pulse check";
    pulseBtn.disabled = true;
  } else {
    pulseStatus.textContent = "Ready whenever you are.";
    pulseBtn.textContent = "Complete pulse check";
    pulseBtn.disabled = false;
  }

  const reflectionBtn = $("#btn-open-reflection");
  const reflectionStatus = $("#reflection-status");
  reflectionBtn.disabled = completed < 4;
  if (journey.reflection) {
    reflectionStatus.textContent = `Submitted${journey.reflection.submittedAt ? ` ${daysAgoLabel(journey.reflection.submittedAt)}` : ""} — you chose to ${OUTCOME_LABELS[journey.outcome] || "continue"}.`;
    reflectionBtn.textContent = "View final reflection";
  } else if (completed < 4) {
    reflectionStatus.textContent = `${completed} of 4 conversations logged — ${4 - completed} more to unlock.`;
    reflectionBtn.textContent = "Complete final reflection";
  } else {
    reflectionStatus.textContent = "Unlocked — ready when you are.";
    reflectionBtn.textContent = "Complete final reflection";
  }
}

function openLogSessionModal() {
  const journey = findActiveJourneyFor(CURRENT_USER_ID);
  const startDate = journey ? getJourneyStartDate(journey) : null;
  const select = $("#log-session-stage");
  select.innerHTML = PROGRAM_META.stages
    .map((s) => `<option value="${s.key}">${s.label}${startDate ? ` (${stageDateRange(startDate, s)})` : ""}</option>`)
    .join("");
  $('#form-log-session input[name="date"]').value = new Date().toISOString().slice(0, 10);
  $('#form-log-session textarea[name="notes"]').value = "";
  openModal("modal-log-session");
}

function meetingTimeLabel(startISO) {
  return new Date(startISO).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function renderUpcomingMeetings(journey) {
  const container = $("#upcoming-meetings-list");
  const meetings = journey.meetings || [];
  const now = new Date();
  const upcoming = meetings.filter((m) => m.status === "scheduled").sort((a, b) => a.startISO.localeCompare(b.startISO));
  const recentlyCancelled = meetings
    .filter((m) => m.status === "cancelled" && m.cancelIcs)
    .sort((a, b) => b.startISO.localeCompare(a.startISO))
    .slice(0, 3);

  if (!upcoming.length && !recentlyCancelled.length) {
    container.innerHTML = `<p class="empty-state">Nothing scheduled yet — create an invite so it lands on both calendars.</p>`;
    return;
  }

  const rows = upcoming.map((m) => {
    const stage = PROGRAM_META.stages.find((s) => s.key === m.stage);
    const isPast = new Date(m.startISO) < now;
    return `
      <div class="session-item">
        <div class="session-item-head"><span>${stage ? stage.label : m.stage} conversation</span><span class="muted small">${meetingTimeLabel(m.startISO)}</span></div>
        <div class="session-item-notes">${isPast ? "This time has passed — log it in your conversation log, or cancel it below." : "Invite sent to both calendars."}</div>
        <div class="match-actions" style="margin-top:8px">
          <button class="btn btn-danger-outline btn-sm" data-action="cancel-meeting" data-id="${m.id}">Cancel meeting</button>
        </div>
      </div>`;
  });

  rows.push(
    ...recentlyCancelled.map((m) => {
      const stage = PROGRAM_META.stages.find((s) => s.key === m.stage);
      return `
      <div class="session-item">
        <div class="session-item-head"><span>${stage ? stage.label : m.stage} conversation — cancelled</span><span class="muted small">${meetingTimeLabel(m.startISO)}</span></div>
        <div class="session-item-notes">Removed from GainForward. Download the cancellation file to also remove it from your calendar.</div>
        <div class="match-actions" style="margin-top:8px">
          <button class="btn btn-ghost btn-sm" data-action="download-cancel-ics" data-id="${m.id}">Download cancellation (.ics)</button>
        </div>
      </div>`;
    })
  );

  container.innerHTML = rows.join("");
}

/** Turns a scheduled meeting into a real CANCEL .ics — same UID, bumped SEQUENCE, per RFC 5545. */
function cancelMeeting(journey, meeting, reasonText) {
  if (!meeting || meeting.status !== "scheduled") return meeting;
  meeting.status = "cancelled";
  meeting.sequence = (meeting.sequence || 0) + 1;
  const stage = PROGRAM_META.stages.find((s) => s.key === meeting.stage);
  const empA = getEmployeeById(journey.participantA);
  const empB = getEmployeeById(journey.participantB);
  const organizer = getEmployeeById(meeting.organizerId) || empA;
  const attendees = [empA, empB].filter(Boolean).map((e) => ({ name: e.fullName, email: e.email })).filter((a) => a.email);

  meeting.cancelIcs = buildICS({
    uid: meeting.uid,
    sequence: meeting.sequence,
    method: "CANCEL",
    status: "CANCELLED",
    title: `GainForward: ${stage ? stage.label : meeting.stage} conversation`,
    description: reasonText || "This conversation was cancelled.",
    start: new Date(meeting.startISO),
    durationMins: meeting.durationMins,
    organizer: organizer ? { name: organizer.fullName, email: organizer.email } : null,
    attendees,
  });
  meeting.cancelFilename = `gainforward-${meeting.stage}-conversation-cancelled.ics`;
  return meeting;
}

/** Auto-cancels every not-yet-occurred meeting on a journey — called the instant a relationship ends. */
function cancelUpcomingMeetings(journey, reasonText) {
  const now = new Date();
  const toCancel = (journey.meetings || []).filter((m) => m.status === "scheduled" && new Date(m.startISO) > now);
  toCancel.forEach((m) => cancelMeeting(journey, m, reasonText));
  return toCancel.length;
}

/* ---------------------------------------------------------------- */
/* Nudges — manual email reminders for mentor, mentee, or PD          */
/* ---------------------------------------------------------------- */
let pendingNudge = null;

function findRelevantJourneyFor(employeeId) {
  return journeys.find((j) => isJourneyOpen(j) && (j.participantA === employeeId || j.participantB === employeeId));
}

function openNudgeModal({ toId }) {
  let recipientId = toId;
  if (!recipientId) {
    const myJourney = findActiveJourneyFor(CURRENT_USER_ID);
    if (!myJourney) {
      toast("You don't have an active journey to nudge anyone about yet.", "error");
      return;
    }
    recipientId = getPartnerId(myJourney, CURRENT_USER_ID);
  }
  const recipient = getEmployeeById(recipientId);
  if (!recipient || recipient.id === CURRENT_USER_ID) return;

  const me = getCurrentUser();
  const firstName = (recipient.fullName || recipient.displayName || "there").split(" ")[0];
  const journey = findRelevantJourneyFor(recipientId);
  const upcoming = journey
    ? (journey.meetings || [])
        .filter((m) => m.status === "scheduled" && new Date(m.startISO) > new Date())
        .sort((a, b) => a.startISO.localeCompare(b.startISO))[0]
    : null;

  let subject, body;
  if (upcoming) {
    const stage = PROGRAM_META.stages.find((s) => s.key === upcoming.stage);
    subject = `Reminder: your ${stage ? stage.label : upcoming.stage} conversation`;
    body = `Hi ${firstName},\n\nJust a quick reminder about our ${stage ? stage.label.toLowerCase() : upcoming.stage} conversation — ${meetingTimeLabel(upcoming.startISO)}. Let me know if the time still works.\n\n${me.fullName}`;
  } else if (journey) {
    subject = "Checking in on GainForward";
    body = `Hi ${firstName},\n\nJust checking in on our mentoring journey — would you like to schedule our next conversation?\n\n${me.fullName}`;
  } else {
    subject = "GainForward — following up";
    body = `Hi ${firstName},\n\nFollowing up on GainForward — let us know if there's anything you need to get started.\n\n${me.fullName}`;
  }

  pendingNudge = { toId: recipientId, subject };
  $("#nudge-to-line").textContent = recipient.email ? `To: ${recipient.displayName} · ${recipient.email}` : `${recipient.displayName} doesn't have an email on file yet — add one to their profile first.`;
  $("#nudge-message").value = body;
  $("#btn-send-nudge").disabled = !recipient.email;
  openModal("modal-nudge");
}

function sendNudge() {
  if (!pendingNudge) return;
  const recipient = getEmployeeById(pendingNudge.toId);
  if (!recipient?.email) return;
  const message = $("#nudge-message").value.trim();
  const link = buildMailtoLink(recipient.email, pendingNudge.subject, message);
  window.location.href = link;

  nudges.unshift({ id: uid("nudge"), fromId: CURRENT_USER_ID, toId: recipient.id, message, sentAt: new Date().toISOString() });
  savePersisted(STORAGE.nudges, nudges);
  toast(`Email draft opened for ${recipient.displayName}.`, "success");
  closeAllModals();
  renderNudgeLog();
}

function renderNudgeLog() {
  const container = $("#nudge-log-list");
  if (!container) return;
  if (!nudges.length) {
    container.innerHTML = `<p class="empty-state">No nudges sent yet.</p>`;
    return;
  }
  container.innerHTML = nudges
    .slice(0, 8)
    .map((n) => {
      const from = getEmployeeById(n.fromId);
      const to = getEmployeeById(n.toId);
      return `
      <div class="session-item">
        <div class="session-item-head"><span>${from ? from.displayName : "?"} → ${to ? to.displayName : "?"}</span><span class="muted small">${daysAgoLabel(n.sentAt.slice(0, 10))}</span></div>
        <div class="session-item-notes">${n.message.split("\n")[0]}</div>
      </div>`;
    })
    .join("");
}

let pendingInvite = null;

function openScheduleMeetingModal() {
  const journey = findActiveJourneyFor(CURRENT_USER_ID);
  if (!journey) return;
  const partner = getEmployeeById(getPartnerId(journey, CURRENT_USER_ID));
  const completed = journey.sessions.filter((s) => s.completed).length;
  const nextStageIndex = clamp(completed, 0, PROGRAM_META.stages.length - 1);

  $("#schedule-stage-select").innerHTML = PROGRAM_META.stages
    .map((s, i) => `<option value="${s.key}" ${i === nextStageIndex ? "selected" : ""}>${s.label}</option>`)
    .join("");
  $("#schedule-with-line").textContent = `With ${partner ? partner.displayName : "your partner"}${partner?.email ? ` (${partner.email})` : ""}.`;

  const form = $("#form-schedule-meeting");
  form.reset();
  form.date.value = new Date().toISOString().slice(0, 10);
  $("#schedule-step-form").classList.remove("hidden");
  $("#schedule-step-result").classList.add("hidden");
  pendingInvite = null;
  openModal("modal-schedule-meeting");
}

function openPulseModal() {
  const journey = findActiveJourneyFor(CURRENT_USER_ID);
  const form = $("#form-pulse");
  if (journey?.pulse) {
    form.q1.value = journey.pulse.q1;
    form.q2.value = journey.pulse.q2;
    form.q3.value = journey.pulse.q3;
    form.q4.value = journey.pulse.q4;
    form.continuation.value = journey.pulse.continuation;
    form.openText.value = journey.pulse.openText || "";
  } else {
    form.reset();
  }
  openModal("modal-pulse");
}

function openReflectionModal() {
  const journey = findActiveJourneyFor(CURRENT_USER_ID);
  const form = $("#form-reflection");
  if (journey?.reflection) {
    const r = journey.reflection;
    form.setOutToLearn.value = r.setOutToLearn;
    form.whatLearned.value = r.whatLearned;
    form.whatPartnerLearned.value = r.whatPartnerLearned || "";
    form.appliedInWorkplace.checked = !!r.appliedInWorkplace;
    form.wouldContinue.value = r.wouldContinue;
    form.wouldRecommend.value = r.wouldRecommend;
    form.whatToChange.value = r.whatToChange || "";
    form.nextStep.value = journey.outcome || "continue";
  } else {
    form.reset();
  }
  openModal("modal-reflection");
}

/* ---------------------------------------------------------------- */
/* Insights                                                           */
/* ---------------------------------------------------------------- */
function kpiValue(key) {
  const totalEmployees = employees.length || 1;
  const cohortAssumed = (PROGRAM_META.cohortTarget.min + PROGRAM_META.cohortTarget.max) / 2;
  const allSessions = journeys.reduce((sum, j) => sum + j.sessions.length, 0);
  const reflections = journeys.map((j) => j.reflection).filter(Boolean);
  const pulses = journeys.map((j) => j.pulse).filter(Boolean);

  switch (key) {
    case "profiles":
      return totalEmployees / cohortAssumed;
    case "connections":
      return journeys.length;
    case "requests":
      return requests.length;
    case "health": {
      if (!pulses.length) return null;
      const avg = pulses.reduce((s, p) => s + (Number(p.q1) + Number(p.q2) + Number(p.q3) + Number(p.q4)) / 4, 0) / pulses.length;
      return avg;
    }
    case "meaningful":
      return journeys.length ? allSessions / (journeys.length * 5) : 0;
    case "continuation":
      if (!reflections.length) return null;
      return reflections.filter((r) => r.wouldContinue === "yes").length / reflections.length;
    case "goalClarity":
      return employees.filter((e) => e.goalStatement && e.goalStatement.trim()).length / totalEmployees;
    case "application":
      if (!reflections.length) return null;
      return reflections.filter((r) => r.appliedInWorkplace).length / reflections.length;
    case "peerShared":
      return journeys.length ? journeys.filter((j) => j.outcome === "contributor").length / journeys.length : 0;
    default:
      return null;
  }
}

function renderKpiGroup(containerId, metrics) {
  const container = $(containerId);
  container.innerHTML = metrics
    .map((m) => {
      const value = kpiValue(m.key);
      let display, progress, targetLabel;
      if (value === null) {
        display = "—";
        progress = 0;
        targetLabel = "Waiting on the first submission";
      } else if (m.format === "percent") {
        display = pct(value);
        progress = m.target ? value / m.target : value;
        targetLabel = m.target ? `Target: ≥${pct(m.target)}` : "Tracked as a trend, no fixed target";
      } else if (m.format === "score") {
        display = `${value.toFixed(1)} / 5`;
        progress = m.target ? value / m.target : value / 5;
        targetLabel = m.target ? `Target: ≥${m.target.toFixed(1)}` : "Tracked as a trend, no fixed target";
      } else {
        display = Math.round(value);
        progress = m.target ? value / m.target : 0.4;
        targetLabel = m.target ? `Target: ${m.target}` : "Tracked as a trend, no fixed target";
      }
      return `
      <div class="kpi-card">
        <div class="kpi-label">${m.label}</div>
        <div class="kpi-value">${display}</div>
        <div class="kpi-target">${targetLabel}</div>
        <div class="kpi-progress progress-track"><div class="progress-fill" style="width:${pct(clamp(progress, 0, 1))}"></div></div>
      </div>`;
    })
    .join("");
}

function renderBarChart(containerId, counts) {
  const max = Math.max(1, ...Object.values(counts));
  const container = $(containerId);
  container.innerHTML = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([label, count]) => `
      <div class="bar-row">
        <span>${label}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct(count / max)}"></div></div>
        <span>${count}</span>
      </div>`
    )
    .join("");
}

function renderInsights() {
  renderKpiGroup("#kpi-adoption", PROGRAM_META.kpis.adoption);
  renderKpiGroup("#kpi-relationship", PROGRAM_META.kpis.relationshipQuality);
  renderKpiGroup("#kpi-learning", PROGRAM_META.kpis.learningImpact);

  const byDept = {};
  const byGeo = {};
  employees.forEach((e) => {
    byDept[e.department] = (byDept[e.department] || 0) + 1;
    byGeo[e.geography] = (byGeo[e.geography] || 0) + 1;
  });
  renderBarChart("#chart-department", byDept);
  renderBarChart("#chart-region", byGeo);
}

/* ---------------------------------------------------------------- */
/* Admin · PD Console                                                 */
/* ---------------------------------------------------------------- */
/** Not a pre-approval gate — connections are already live by the time they show up
 * here. This is PD's guardrail: review why the system paired two people, and end
 * (no-fault rematch) a connection at any point if something looks off. */
function renderMatchingQueue() {
  const container = $("#matching-queue");
  const activeJourneys = journeys.filter((j) => j.formalStatus === "active");

  if (!activeJourneys.length) {
    container.innerHTML = `<p class="empty-state">No active connections yet. New ones form automatically from the Directory and will show up here for review.</p>`;
    return;
  }

  container.innerHTML = activeJourneys
    .map((j) => {
      const from = getEmployeeById(j.participantA);
      const to = getEmployeeById(j.participantB);
      const req = requests.find((r) => r.fromId === j.participantA && r.toId === j.participantB && r.status === "accepted");
      const scored = req ? { total: req.score, breakdown: req.breakdown } : from && to ? computeMatchScore(from, to) : { total: 0, breakdown: [] };
      const checklist = req ? req.checklist : from && to ? matchQualityAnswerDefaults(from, to) : [];
      const reasons = from && to ? matchReasons(from, to, scored.breakdown) : [];
      const checklistKey = req ? req.id : j.id;

      return `
      <div class="match-item">
        <div class="match-item-head">
          <span class="match-item-pair">${from ? from.displayName : "?"} ↔ ${to ? to.displayName : "?"}</span>
          <span class="match-score-badge" title="${scoreVerdict(scored.total)}">${scored.total}% · ${scoreVerdict(scored.total)}</span>
        </div>
        <ul class="tip-list match-reasons">${reasons.map((rs) => `<li>${rs}</li>`).join("")}</ul>
        <details class="score-details">
          <summary>Review checklist</summary>
          <div class="checklist" style="margin-top:8px">
            ${checklist
              .map(
                (c, i) => `
              <label><input type="checkbox" data-checklist="${checklistKey}:${i}" ${c.checked ? "checked" : ""} /> ${c.question}</label>`
              )
              .join("")}
          </div>
        </details>
        <div class="match-actions">
          <button class="btn btn-danger-outline btn-sm" data-action="rematch" data-id="${j.id}">End connection (rematch)</button>
        </div>
      </div>`;
    })
    .join("");

  $all("[data-checklist]").forEach((box) => {
    box.addEventListener("change", (e) => {
      const [reqId, idx] = e.target.dataset.checklist.split(":");
      const req = requests.find((r) => r.id === reqId);
      if (!req) return;
      req.checklist[Number(idx)].checked = e.target.checked;
      savePersisted(STORAGE.requests, requests);
    });
  });
}

function renderRoster() {
  const search = ($("#roster-search").value || "").trim().toLowerCase();
  const rows = employees.filter((e) => {
    if (!search) return true;
    return `${e.fullName} ${e.department}`.toLowerCase().includes(search);
  });

  $("#roster-body").innerHTML = rows
    .map((e) => {
      const journey = findActiveJourneyFor(e.id);
      const partner = journey ? getEmployeeById(getPartnerId(journey, e.id)) : null;
      return `
      <tr>
        <td>${e.displayName}${e.id === CURRENT_USER_ID ? " (you)" : ""}</td>
        <td>${e.department}</td>
        <td>${e.geography}</td>
        <td>${formatLabel(e.preferredFormat)}</td>
        <td>
          <select data-status-for="${e.id}">
            ${["available", "active", "paused", "closed"].map((s) => `<option value="${s}" ${e.engagementStatus === s ? "selected" : ""}>${statusLabel(s)}</option>`).join("")}
          </select>
        </td>
        <td>${partner ? `${partner.displayName}` : "—"}</td>
        <td>
          <div class="row-actions">
            ${e.id !== CURRENT_USER_ID ? `<button class="btn btn-ghost btn-sm" data-action="open-nudge" data-id="${e.id}">Nudge</button>` : ""}
            ${journey ? `<button class="btn btn-ghost btn-sm" data-action="rematch" data-id="${journey.id}">Rematch</button>` : ""}
          </div>
        </td>
      </tr>`;
    })
    .join("");

  $all("[data-status-for]").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const emp = getEmployeeById(e.target.dataset.statusFor);
      emp.engagementStatus = e.target.value;
      persistEmployeeOverride(emp);
      renderDirectory();
    });
  });
}

function persistEmployeeOverride(emp) {
  const overrides = loadPersisted(STORAGE.overrides, {});
  overrides[emp.id] = { ...(overrides[emp.id] || {}), engagementStatus: emp.engagementStatus };
  savePersisted(STORAGE.overrides, overrides);
}

/** Merges submitted profile fields onto the current user, in memory and in localStorage. */
function saveCurrentUserProfile(fields) {
  const me = getCurrentUser();
  Object.assign(me, fields);
  const overrides = loadPersisted(STORAGE.overrides, {});
  overrides[me.id] = { ...(overrides[me.id] || {}), ...fields };
  savePersisted(STORAGE.overrides, overrides);
}

function triggerRematch(journeyId) {
  const journey = journeys.find((j) => j.id === journeyId);
  if (!journey) return;
  journey.formalStatus = "closed";
  journey.outcome = "rematch";
  const cancelledCount = cancelUpcomingMeetings(journey, "This relationship was rematched before this conversation happened.");
  savePersisted(STORAGE.journeys, journeys);
  toast(
    cancelledCount
      ? `No-fault rematch recorded. ${cancelledCount} upcoming calendar invite${cancelledCount === 1 ? "" : "s"} cancelled automatically — download the cancellation file${cancelledCount === 1 ? "" : "s"} from My Journey to clear ${cancelledCount === 1 ? "it" : "them"} off your calendar.`
      : "No-fault rematch recorded. Both participants can now find a new match.",
    "success"
  );
  renderAdmin();
  renderJourney();
  renderHome();
}

function renderDecisionGates() {
  $("#decision-gates").innerHTML = PROGRAM_META.decisionGates
    .map(
      (g) => `
    <div class="gate-card">
      <div class="gate-title">${g.label}</div>
      <div class="gate-question">${g.question}</div>
      <div class="gate-status">
        <select data-gate="${g.key}">
          ${["Not started", "In progress", "Passed", "Blocked"].map((s) => `<option ${gateStatus[g.key] === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
    </div>`
    )
    .join("");

  $all("[data-gate]").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      gateStatus[e.target.dataset.gate] = e.target.value;
      savePersisted(STORAGE.gates, gateStatus);
    });
  });
}

function renderAdmin() {
  renderMatchingQueue();
  renderRoster();
  renderDecisionGates();
  renderNudgeLog();
}

/* ---------------------------------------------------------------- */
/* Resources modal                                                    */
/* ---------------------------------------------------------------- */
const RESOURCE_TABS = [
  { key: "faqs", label: "FAQs" },
  { key: "bestPractices", label: "Best Practices" },
  { key: "mentorTips", label: "For Mentors" },
  { key: "menteeTips", label: "For Mentees" },
  { key: "dos", label: "Do's & Don'ts" },
  { key: "makingTheMost", label: "Making the Most of It" },
  { key: "linkedinCourses", label: "LinkedIn Learning" },
];
let currentResourceTab = "faqs";

function renderResources() {
  currentResourceTab = "faqs";
  renderResourceTabs();
  renderResourcePanel();
}

function renderResourceTabs() {
  $("#resource-tabs").innerHTML = RESOURCE_TABS.map(
    (t) => `<button class="resource-tab-btn ${t.key === currentResourceTab ? "is-active" : ""}" data-action="switch-resource-tab" data-key="${t.key}">${t.label}</button>`
  ).join("");
}

function renderResourcePanel() {
  const panel = $("#resource-panel");
  const key = currentResourceTab;

  if (key === "faqs") {
    panel.innerHTML = RESOURCE_LIBRARY.faqs
      .map(
        (item, i) => `
      <div class="accordion-item">
        <button class="accordion-trigger" data-action="toggle-accordion" data-idx="faq-${i}">${item.q}</button>
        <div class="accordion-panel hidden" data-panel="faq-${i}">${item.a}</div>
      </div>`
      )
      .join("");
  } else if (key === "bestPractices" || key === "mentorTips" || key === "menteeTips") {
    const article = RESOURCE_LIBRARY[key];
    panel.innerHTML = `
      <p class="article-intro">${article.intro}</p>
      ${article.sections
        .map((s) => `<div class="article-section"><h4>${s.heading}</h4><p>${s.body}</p></div>`)
        .join("")}`;
  } else if (key === "dos") {
    panel.innerHTML = `
      <p class="article-intro">${RESOURCE_LIBRARY.dosDontsIntro}</p>
      <div class="dos-donts">
        <div class="dos-col">
          <h4 class="dos-heading dos-heading--do">Do</h4>
          <ul class="tip-list tip-list--do">${RESOURCE_LIBRARY.dos.map((d) => `<li>${d}</li>`).join("")}</ul>
        </div>
        <div class="dos-col">
          <h4 class="dos-heading dos-heading--dont">Don't</h4>
          <ul class="tip-list tip-list--dont">${RESOURCE_LIBRARY.donts.map((d) => `<li>${d}</li>`).join("")}</ul>
        </div>
      </div>`;
  } else if (key === "makingTheMost") {
    panel.innerHTML = `
      <p class="article-intro">${RESOURCE_LIBRARY.makingTheMost.intro}</p>
      ${RESOURCE_LIBRARY.makingTheMost.phases
        .map((item) => `<div class="phase-tip"><span class="phase-tag">${item.phase}</span><span>${item.tip}</span></div>`)
        .join("")}`;
  } else if (key === "linkedinCourses") {
    panel.innerHTML = `
      <p class="muted small">Commonly available through most LinkedIn Learning enterprise subscriptions — search the title in your LinkedIn Learning portal to confirm your access.</p>
      ${RESOURCE_LIBRARY.linkedinCourses
        .map(
          (c) => `
        <div class="course-card">
          <div class="course-title">${c.title}</div>
          <div class="course-meta">${c.instructor}</div>
          <div class="course-note">${c.note}</div>
          <a class="course-link" href="${c.url}" target="_blank" rel="noopener">Open course ↗</a>
        </div>`
        )
        .join("")}`;
  }
}

/* ---------------------------------------------------------------- */
/* Settings / AI data source                                          */
/* ---------------------------------------------------------------- */
function updateDataSourceDot() {
  const dot = $("#data-source-dot");
  dot.className = "status-dot " + (dataSourceInfo.source === "ai" ? "status-dot--ai" : dataSourceInfo.source === "seed-fallback" ? "status-dot--error" : "status-dot--seed");
  dot.title =
    dataSourceInfo.source === "ai"
      ? "Live employee data connected"
      : dataSourceInfo.source === "seed-fallback"
      ? `AI source failed (${dataSourceInfo.error || "unknown error"}) — showing demo roster`
      : "Showing demo roster — configure your AI data source";
}

function openSettingsModal() {
  const config = getAIConfig();
  const form = $("#form-settings");
  form.provider.value = config.provider || "custom";
  form.endpoint.value = config.endpoint || "";
  form.apiKey.value = config.apiKey || "";
  form.enabled.checked = !!config.enabled;
  $("#settings-test-result").textContent = "";
  $("#settings-test-result").className = "settings-test-result";
  openModal("modal-settings");
}

async function refreshEmployeeSource() {
  const result = await loadEmployeeDirectory();
  dataSourceInfo = result;
  const overrides = loadPersisted(STORAGE.overrides, {});
  const addedEmployees = loadPersisted(STORAGE.addedEmployees, []);
  employees = [...result.employees, ...addedEmployees];
  employees.forEach((e) => {
    if (overrides[e.id]) Object.assign(e, overrides[e.id]);
  });
  ensureCurrentUser();
  updateDataSourceDot();
  populateFilterDropdowns();
}

/** Identity comes from the demo login, not the seed data — inject the logged-in persona here. */
/** All 5 demo personas are always real, visible employees — not just the one
 * currently logged in — so admin/roster/journeys involving any of them render
 * correctly regardless of who's actually signed in on this browser. */
function ensureCurrentUser() {
  const activeId = localStorage.getItem(STORAGE.activeDemoUser);
  const overrides = loadPersisted(STORAGE.overrides, {});

  DEMO_ACCOUNTS.forEach((account) => {
    employees = employees.filter((e) => e.id !== account.id);
    employees.unshift({
      id: account.id,
      isCurrentUser: account.id === activeId,
      ...account.employee,
      ...(overrides[account.id] || {}),
    });
  });

  let current = employees.find((e) => e.isCurrentUser);
  if (!current) {
    current = {
      id: CURRENT_USER_ID || "u-unknown",
      isCurrentUser: true,
      profileComplete: false,
      fullName: "You",
      displayName: "You",
      avatarInitials: "YOU",
      email: "",
      department: "—",
      geography: "—",
      careerLevel: "—",
      tenureBand: "—",
      learningGoals: [],
      learningSkillCategory: "",
      offeredSkills: [],
      mentorSkillCategory: "",
      goalStatement: "",
      purpose: "",
      skillLevel: "",
      preferredFormat: "",
      engagementStatus: "available",
      rating: null,
      menteeCount: 0,
      consentAck: false,
    };
    employees.unshift(current);
  }

  CURRENT_USER_ID = current.id;
}

/* ---------------------------------------------------------------- */
/* Journey seeding (first run only)                                   */
/* ---------------------------------------------------------------- */
function ensureJourneysSeeded() {
  if (journeys !== null) return;
  journeys = [
    {
      id: "j-seed-1",
      participantA: "demo-mentee-2",
      participantB: "e-meyer",
      relationshipType: "1:1 Mentoring",
      formalStatus: "active",
      startDate: "2026-07-09",
      sessions: [
        { id: "s1", stage: "connect", date: "2026-07-09", notes: "Built trust, agreed on a bi-weekly cadence.", completed: true },
        { id: "s2", stage: "goal", date: "2026-07-21", notes: "Set 'present forecasts to leadership' as the goal.", completed: true },
        { id: "s3", stage: "challenge", date: "2026-08-04", notes: "Walked through a real leadership deck together.", completed: true },
      ],
      meetings: [
        { id: "m-seed-1", uid: "m-seed-1@gainforward.rategain.com", stage: "apply", startISO: "2026-08-29T15:00:00.000Z", durationMins: 45, status: "scheduled", sequence: 0, organizerId: "demo-mentee-2" },
      ],
      pulse: null,
      reflection: null,
    },
  ];
  savePersisted(STORAGE.journeys, journeys);
}

/** Backfills journeys persisted before the meetings/calendar feature existed. */
function ensureMeetingsField() {
  journeys.forEach((j) => {
    if (!j.meetings) j.meetings = [];
  });
}

/* ---------------------------------------------------------------- */
/* Event wiring                                                       */
/* ---------------------------------------------------------------- */
function wireEvents() {
  $("#form-login").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const username = fd.get("username").trim().toLowerCase();
    const password = fd.get("password");
    const account = DEMO_ACCOUNTS.find((a) => a.username === username && a.password === password);
    const errorEl = $("#login-error");
    if (!account) {
      errorEl.textContent = "Incorrect username or password.";
      return;
    }
    errorEl.textContent = "";
    localStorage.setItem(STORAGE.activeDemoUser, account.id);
    e.target.reset();
    startApp();
  });

  $all(".tab-btn").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

  document.body.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    switch (action) {
      case "goto-directory":
        switchTab("directory");
        break;
      case "goto-journey":
        switchTab("journey");
        break;
      case "open-become-mentor-role":
        openBecomeMentorRoleModal();
        break;
      case "open-become-mentee-role":
        openBecomeMenteeRoleModal();
        break;
      case "switch-resource-tab":
        currentResourceTab = el.dataset.key;
        renderResourceTabs();
        renderResourcePanel();
        break;
      case "export-excel":
        exportExcelReport();
        break;
      case "export-pdf":
        exportPDFReport();
        break;
      case "export-png":
        exportPNGReport();
        break;
      case "open-resources":
        renderResources();
        openModal("modal-resources");
        break;
      case "close-modal":
        closeAllModals();
        break;
      case "open-settings":
        openSettingsModal();
        $("#user-menu").classList.add("hidden");
        break;
      case "view-profile":
        $("#user-menu").classList.add("hidden");
        openProfileModal({ onboarding: false });
        break;
      case "sign-out":
        $("#user-menu").classList.add("hidden");
        localStorage.removeItem(STORAGE.activeDemoUser);
        CURRENT_USER_ID = null;
        showLoginScreen();
        break;
      case "request-mentor":
        openMatchModalFor(el.dataset.id);
        break;
      case "open-log-session":
        openLogSessionModal();
        break;
      case "open-schedule-meeting":
        openScheduleMeetingModal();
        break;
      case "open-nudge":
        openNudgeModal({ toId: el.dataset.id || null });
        break;
      case "send-nudge":
        sendNudge();
        break;
      case "open-pulse":
        openPulseModal();
        break;
      case "cancel-meeting": {
        const journey = journeys.find((j) => (j.meetings || []).some((m) => m.id === el.dataset.id));
        const meeting = journey?.meetings.find((m) => m.id === el.dataset.id);
        if (journey && meeting) {
          cancelMeeting(journey, meeting, "Cancelled by participant.");
          savePersisted(STORAGE.journeys, journeys);
          toast("Meeting cancelled. Download the cancellation file to remove it from your calendar too.", "success");
          renderJourney();
          renderHome();
        }
        break;
      }
      case "download-cancel-ics": {
        const journey = journeys.find((j) => (j.meetings || []).some((m) => m.id === el.dataset.id));
        const meeting = journey?.meetings.find((m) => m.id === el.dataset.id);
        if (meeting?.cancelIcs) downloadICS(meeting.cancelFilename, meeting.cancelIcs);
        break;
      }
      case "rematch":
        triggerRematch(el.dataset.id);
        break;
      case "toggle-accordion": {
        const panel = $(`[data-panel="${el.dataset.idx}"]`);
        panel.classList.toggle("hidden");
        break;
      }
      case "clear-settings":
        clearAIConfig();
        openSettingsModal();
        refreshEmployeeSource().then(renderHome);
        toast("Data source cleared — back to the demo roster.");
        break;
    }
  });

  $("#btn-data-source").addEventListener("click", openSettingsModal);

  $("#user-avatar-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#user-menu").classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".avatar-menu")) $("#user-menu").classList.add("hidden");
  });

  $("#modal-backdrop").addEventListener("click", () => closeAllModals());

  $("#directory-search").addEventListener("input", renderDirectory);
  $("#filter-department").addEventListener("change", renderDirectory);
  $("#filter-geo").addEventListener("change", renderDirectory);
  $("#filter-format").addEventListener("change", renderDirectory);
  $("#roster-search").addEventListener("input", renderRoster);

  $("#btn-open-reflection").addEventListener("click", openReflectionModal);

  $("#form-become-mentor").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const fullName = fd.get("fullName").trim();
    const parts = fullName.split(/\s+/);
    const initials = parts.map((p) => p[0]?.toUpperCase() || "").join("").slice(0, 2) || "??";
    const displayName = parts.length > 1 ? `${parts[0][0]}. ${parts[parts.length - 1]}` : fullName;
    const wasOnboarding = isOnboarding;
    const me = getCurrentUser();

    const fields = {
      fullName,
      displayName,
      avatarInitials: initials,
      email: fd.get("email").trim(),
      department: fd.get("department").trim(),
      division: fd.get("department").trim(),
      geography: fd.get("geography"),
      consentAck: fd.get("consentAck") === "on",
      profileComplete: true,
      learningGoals: fd
        .get("learningGoals")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3),
      skillLevel: fd.get("skillLevel"),
      learningSkillCategory: fd.get("learningSkillCategory"),
      offeredSkills: fd
        .get("offeredSkills")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5),
      mentorSkillCategory: fd.get("mentorSkillCategory"),
      goalStatement: fd.get("goalStatement").trim(),
      purpose: fd.get("purpose").trim(),
      preferredFormat: fd.get("preferredFormat"),
      aiConfidence: fd.get("aiConfidence"),
      availability: { ...me.availability, frequency: fd.get("frequency"), timezone: fd.get("timezone").trim() || "—" },
      matchNote: fd.get("matchNote").trim(),
    };

    saveCurrentUserProfile(fields);
    isOnboarding = false;

    toast(wasOnboarding ? `Welcome, ${displayName} — your profile is set up.` : "Profile updated.", "success");
    closeAllModals(true);
    populateFilterDropdowns();
    renderUserChrome();
    renderDirectory();
    renderHome();
  });

  $("#form-become-mentor-role").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const me = getCurrentUser();
    const fullName = fd.get("fullName").trim();
    const parts = fullName.split(/\s+/);
    saveCurrentUserProfile({
      fullName,
      displayName: parts.length > 1 ? `${parts[0][0]}. ${parts[parts.length - 1]}` : fullName,
      avatarInitials: parts.map((p) => p[0]?.toUpperCase() || "").join("").slice(0, 2) || "??",
      email: fd.get("email").trim(),
      department: fd.get("department").trim(),
      division: fd.get("department").trim(),
      geography: fd.get("geography"),
      purpose: fd.get("purpose").trim(),
      mentorSkillCategory: fd.get("mentorSkillCategory"),
      offeredSkills: fd
        .get("offeredSkills")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5),
      availability: { ...me.availability, frequency: fd.get("frequency"), timezone: fd.get("timezone").trim() || "—" },
      consentAck: fd.get("consentAck") === "on",
      preferredFormat: "mentor",
      engagementStatus: me.engagementStatus === "closed" ? "available" : me.engagementStatus,
      profileComplete: true,
    });
    toast("You're set up as a mentor — you'll now show up in the Directory.", "success");
    closeAllModals();
    renderUserChrome();
    populateFilterDropdowns();
    renderDirectory();
    renderHome();
  });

  $("#form-become-mentee-role").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const me = getCurrentUser();
    const fullName = fd.get("fullName").trim();
    const parts = fullName.split(/\s+/);
    saveCurrentUserProfile({
      fullName,
      displayName: parts.length > 1 ? `${parts[0][0]}. ${parts[parts.length - 1]}` : fullName,
      avatarInitials: parts.map((p) => p[0]?.toUpperCase() || "").join("").slice(0, 2) || "??",
      email: fd.get("email").trim(),
      department: fd.get("department").trim(),
      division: fd.get("department").trim(),
      geography: fd.get("geography"),
      learningGoals: fd
        .get("learningGoals")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3),
      skillLevel: fd.get("skillLevel"),
      learningSkillCategory: fd.get("learningSkillCategory"),
      availability: { ...me.availability, frequency: fd.get("frequency"), timezone: fd.get("timezone").trim() || "—" },
      goalStatement: fd.get("goalStatement").trim(),
      consentAck: fd.get("consentAck") === "on",
      preferredFormat: "mentee",
      engagementStatus: me.engagementStatus === "closed" ? "available" : me.engagementStatus,
      profileComplete: true,
    });
    toast("You're set up as a mentee — let's find you a mentor.", "success");
    closeAllModals();
    renderUserChrome();
    populateFilterDropdowns();
    renderHome();
    switchTab("directory");
  });

  $("#form-log-session").addEventListener("submit", (e) => {
    e.preventDefault();
    const journey = findActiveJourneyFor(CURRENT_USER_ID);
    if (!journey) return;
    const fd = new FormData(e.target);
    const stage = fd.get("stage");
    journey.sessions.push({ id: uid("s"), stage, date: fd.get("date"), notes: fd.get("notes").trim(), completed: true });
    const matchingMeeting = (journey.meetings || []).find((m) => m.stage === stage && m.status === "scheduled" && new Date(m.startISO) <= new Date());
    if (matchingMeeting) matchingMeeting.status = "completed";
    savePersisted(STORAGE.journeys, journeys);
    toast("Session logged.", "success");
    e.target.reset();
    closeAllModals();
    renderJourney();
    renderHome();
  });

  $("#form-schedule-meeting").addEventListener("submit", (e) => {
    e.preventDefault();
    const journey = findActiveJourneyFor(CURRENT_USER_ID);
    if (!journey) return;
    const partner = getEmployeeById(getPartnerId(journey, CURRENT_USER_ID));
    const me = getCurrentUser();
    const fd = new FormData(e.target);
    const stageKey = fd.get("stage");
    const stage = PROGRAM_META.stages.find((s) => s.key === stageKey);
    const start = new Date(`${fd.get("date")}T${fd.get("time")}:00`);
    const durationMins = Number(fd.get("duration"));

    if (isNaN(start.getTime()) || start.getTime() < Date.now() - 5 * 60000) {
      toast("Pick a date and time in the future.", "error");
      return;
    }

    const meetingId = uid("meet");
    const calUid = `${meetingId}@gainforward.rategain.com`;
    const title = `GainForward: ${stage ? stage.label : stageKey} conversation`;
    const description = `${stage ? stage.detail : ""}\n\nScheduled from GainForward — ${journey.relationshipType}.`;
    const attendees = [
      { name: me.fullName, email: me.email },
      { name: partner?.fullName, email: partner?.email },
    ].filter((a) => a.email);

    const icsText = buildICS({
      uid: calUid,
      sequence: 0,
      method: "REQUEST",
      status: "CONFIRMED",
      title,
      description,
      location: "Video call — link shared separately",
      start,
      durationMins,
      organizer: { name: me.fullName, email: me.email },
      attendees,
      reminders: [1440, 30],
    });

    journey.meetings = journey.meetings || [];
    journey.meetings.push({ id: meetingId, uid: calUid, stage: stageKey, startISO: start.toISOString(), durationMins, status: "scheduled", sequence: 0, organizerId: CURRENT_USER_ID });
    savePersisted(STORAGE.journeys, journeys);

    pendingInvite = {
      icsText,
      filename: `gainforward-${stageKey}-conversation.ics`,
      googleUrl: googleCalendarLink({ title, description, location: "", start, durationMins }),
      outlookUrl: outlookWebLink({ title, description, location: "", start, durationMins, attendees }),
    };

    $("#schedule-result-summary").textContent = `Invite ready for your ${stage ? stage.label.toLowerCase() : stageKey} conversation — ${meetingTimeLabel(start.toISOString())}.`;
    $("#schedule-result-note").textContent = partner?.email
      ? `The .ics download carries reminders 1 day and 30 minutes before. The one-click Google/Outlook links use each calendar's own default reminder instead — they don't support custom alarms.`
      : `We couldn't find an email for ${partner ? partner.displayName : "your partner"}, so only you're listed as an attendee — add them manually once it's on your calendar.`;
    $("#schedule-step-form").classList.add("hidden");
    $("#schedule-step-result").classList.remove("hidden");

    toast("Conversation scheduled.", "success");
    renderJourney();
    renderHome();
  });

  $("#btn-add-google").addEventListener("click", () => {
    if (pendingInvite) window.open(pendingInvite.googleUrl, "_blank", "noopener");
  });
  $("#btn-add-outlook").addEventListener("click", () => {
    if (pendingInvite) window.open(pendingInvite.outlookUrl, "_blank", "noopener");
  });
  $("#btn-download-ics").addEventListener("click", () => {
    if (pendingInvite) downloadICS(pendingInvite.filename, pendingInvite.icsText);
  });

  $("#form-pulse").addEventListener("submit", (e) => {
    e.preventDefault();
    const journey = findActiveJourneyFor(CURRENT_USER_ID);
    if (!journey) return;
    const fd = new FormData(e.target);
    journey.pulse = {
      q1: fd.get("q1"),
      q2: fd.get("q2"),
      q3: fd.get("q3"),
      q4: fd.get("q4"),
      continuation: fd.get("continuation"),
      openText: fd.get("openText").trim(),
      submittedAt: new Date().toISOString().slice(0, 10),
    };
    savePersisted(STORAGE.journeys, journeys);
    toast("Pulse check submitted — thanks for the honest signal.", "success");
    closeAllModals();
    renderJourney();
  });

  $("#form-reflection").addEventListener("submit", (e) => {
    e.preventDefault();
    const journey = findActiveJourneyFor(CURRENT_USER_ID);
    if (!journey) return;
    const fd = new FormData(e.target);
    journey.reflection = {
      setOutToLearn: fd.get("setOutToLearn").trim(),
      whatLearned: fd.get("whatLearned").trim(),
      whatPartnerLearned: fd.get("whatPartnerLearned").trim(),
      appliedInWorkplace: fd.get("appliedInWorkplace") === "on",
      wouldContinue: fd.get("wouldContinue"),
      wouldRecommend: fd.get("wouldRecommend"),
      whatToChange: fd.get("whatToChange").trim(),
      submittedAt: new Date().toISOString().slice(0, 10),
    };
    const nextStep = fd.get("nextStep");
    journey.outcome = nextStep;
    let cancelledCount = 0;
    if (nextStep !== "continue") {
      journey.formalStatus = "closed";
      cancelledCount = cancelUpcomingMeetings(journey, `This relationship closed (${OUTCOME_LABELS[nextStep] || nextStep}) before this conversation happened.`);
    }
    savePersisted(STORAGE.journeys, journeys);
    toast(
      cancelledCount
        ? `Final reflection submitted. ${cancelledCount} upcoming calendar invite${cancelledCount === 1 ? "" : "s"} cancelled automatically — download the cancellation file below to clear ${cancelledCount === 1 ? "it" : "them"} off your calendar.`
        : "Final reflection submitted. Thank you for closing the loop.",
      "success"
    );
    closeAllModals();
    renderJourney();
    renderHome();
  });

  $("#form-settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    saveAIConfig({
      provider: fd.get("provider"),
      endpoint: fd.get("endpoint").trim(),
      apiKey: fd.get("apiKey"),
      enabled: fd.get("enabled") === "on",
    });
    toast("Data source saved.", "success");
    await refreshEmployeeSource();
    renderHome();
    closeAllModals();
  });

  $("#btn-test-connection").addEventListener("click", async () => {
    const form = $("#form-settings");
    const result = $("#settings-test-result");
    const config = {
      provider: form.provider.value,
      endpoint: form.endpoint.value.trim(),
      apiKey: form.apiKey.value,
    };
    result.className = "settings-test-result";
    result.textContent = "Testing…";
    try {
      const list = await fetchEmployeesFromAI(config);
      result.className = "settings-test-result ok";
      result.textContent = `Connected — received ${list.length} employee record${list.length === 1 ? "" : "s"}.`;
    } catch (err) {
      result.className = "settings-test-result error";
      result.textContent = `Failed: ${err.message}`;
    }
  });
}

/* ---------------------------------------------------------------- */
/* Init                                                               */
/* ---------------------------------------------------------------- */
function showLoginScreen() {
  $("#login-screen").classList.remove("hidden");
  $("#login-username").focus();
}

async function startApp() {
  $("#login-screen").classList.add("hidden");
  await refreshEmployeeSource();
  ensureJourneysSeeded();
  ensureMeetingsField();
  renderUserChrome();
  renderHome();
  // No forced profile gate — signing up happens when someone clicks "I want to
  // become a Mentor/Mentee" on Home. Until then they can look around freely.
}

async function init() {
  wireEvents();
  const activeId = localStorage.getItem(STORAGE.activeDemoUser);
  if (activeId && DEMO_ACCOUNTS.some((a) => a.id === activeId)) {
    await startApp();
  } else {
    showLoginScreen();
  }
}

init();
