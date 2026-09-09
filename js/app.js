/* GainForward: app logic (tabs, forms, matching, journeys, insights, admin). */

const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STORAGE = {
  requests: "gainforward.requests",
  journeys: "gainforward.journeys",
  addedEmployees: "gainforward.addedEmployees",
  overrides: "gainforward.employeeOverrides",
  nudges: "gainforward.nudges",
  activeDemoUser: "gainforward.activeDemoUser",
};

let CURRENT_USER_ID = null;
let employees = [];
let requests = loadPersisted(STORAGE.requests, []);
let journeys = loadPersisted(STORAGE.journeys, null); // null = not yet seeded this browser
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
/** Real calendar window for a stage, given the journey's own start date (not a generic template). */
function stageDateRange(startDateStr, stage) {
  const from = addDays(startDateStr, (stage.weekStart - 1) * 7);
  const to = addDays(startDateStr, stage.weekEnd * 7 - 1);
  return `${formatDateShort(from)} – ${formatDateShort(to)}`;
}
function weekNumberFor(startDateStr, referenceDate) {
  return clamp(Math.floor(daysBetween(startDateStr, referenceDate || new Date()) / 7) + 1, 1, 12);
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
function findActiveJourneysFor(userId) {
  return journeys.filter((j) => isJourneyOpen(j) && (j.participantA === userId || j.participantB === userId));
}
function getPartnerId(journey, userId) {
  return journey.participantA === userId ? journey.participantB : journey.participantA;
}
/** Mentors can hold multiple concurrent connections up to their stated capacity;
 * everyone else (mentees, peers, reverse) is still capped at one at a time. */
function isAtCapacity(userId) {
  const person = getEmployeeById(userId);
  if (!person) return true;
  const activeCount = findActiveJourneysFor(userId).length;
  if (person.preferredFormat === "mentor" && person.menteeCapacity) {
    return activeCount >= person.menteeCapacity;
  }
  return activeCount >= 1;
}
function hasOpenJourneyBetween(idA, idB) {
  return journeys.some((j) => isJourneyOpen(j) && ((j.participantA === idA && j.participantB === idB) || (j.participantA === idB && j.participantB === idA)));
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

/** Profile photo: undefined = untouched this session, null = explicitly
 * removed, a data URL = a new photo just picked. Resized/cropped client-side
 * (there's no server to do it) so it doesn't bloat localStorage. */
let pendingPhotoUrl;

function resizeImageToDataURL(file, size) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Couldn't load that image."));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
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
  pendingPhotoUrl = undefined;
  applyAvatarVisual($("#profile-photo-preview"), me);
  $("#profile-photo-remove").classList.toggle("hidden", !me.photoUrl);
  $("#profile-photo-input").value = "";
  form.fullName.value = me.fullName || "";
  form.email.value = me.email || "";
  form.department.value = me.department || "";
  if (me.geography) form.geography.value = me.geography;
  form.learningGoals.value = (me.learningGoals || []).join(", ");
  form.learningSkillCategory.value = me.learningSkillCategory || "";
  form.skillLevel.value = me.skillLevel || "";
  form.offeredSkills.value = (me.offeredSkills || []).join(", ");
  form.mentorSkillCategory.value = me.mentorSkillCategory || "";
  if (me.menteeCapacity) form.menteeCapacity.value = me.menteeCapacity;
  form.goalStatement.value = me.goalStatement || "";
  form.purpose.value = me.purpose || "";
  if (me.preferredFormat) form.preferredFormat.value = me.preferredFormat;
  if (me.aiConfidence) form.aiConfidence.value = me.aiConfidence;
  if (me.availability?.frequency) form.frequency.value = me.availability.frequency;
  if (me.availability?.hours) form.hours.value = me.availability.hours;
  form.timezone.value = me.availability?.timezone || "";
  form.matchNote.value = me.matchNote || "";
  form.consentAck.checked = !!me.consentAck;

  // Sign-up builds the full profile in one go; this is the only place all of
  // this is asked, so there's nothing left to fill in piecemeal later.
  $("#profile-modal-title").textContent = onboarding ? "Welcome to GainForward, let's build your profile" : "Your profile";
  $("#profile-modal-intro").textContent = onboarding
    ? "This is what powers your matches (about 5–7 minutes)."
    : "Update what you're learning, offering, and how you'd like to participate.";
  $("#profile-modal-close").classList.toggle("hidden", onboarding);
  $("#profile-modal-cancel").classList.toggle("hidden", onboarding);
  $("#profile-modal-submit").textContent = onboarding ? "Create my profile" : "Save changes";

  refreshSkillSuggestions(form, "learningSkillCategory", "profile-learning-suggestions", "learningGoals");
  refreshSkillSuggestions(form, "mentorSkillCategory", "profile-offering-suggestions", "offeredSkills");
  openModal("modal-become-mentor");
}

/** Renders an avatar as a photo when one's set, falling back to initials. */
function avatarHTML(person, extraClass = "") {
  const cls = `avatar ${extraClass}`.trim();
  return person?.photoUrl ? `<img class="${cls}" src="${person.photoUrl}" alt="" />` : `<div class="${cls}">${person?.avatarInitials || "?"}</div>`;
}

/** Same fallback, but for a fixed element (button/div) whose content we set in place. */
function applyAvatarVisual(el, person) {
  if (person?.photoUrl) {
    el.style.backgroundImage = `url("${person.photoUrl}")`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.textContent = person?.avatarInitials || "?";
  }
}

function renderUserChrome() {
  const me = getCurrentUser();
  applyAvatarVisual($("#user-avatar-btn"), me);
  applyAvatarVisual($("#dropdown-avatar"), me);
  $("#dropdown-name").textContent = me.fullName || "Your name";
  $("#dropdown-role").textContent = me.profileComplete ? `${me.department || "—"} · ${me.geography || "—"}` : "Profile not set up yet";
  applyAccessGate();
}

/** Before a profile exists, a new user can only pick a role, nothing else,
 * so Home and the nav don't show sections that don't mean anything yet. */
function applyAccessGate() {
  const me = getCurrentUser();
  const locked = !me.profileComplete;
  const isAdmin = !!me.isAdmin;
  $all(".nav-tab-gated").forEach((btn) => {
    const needsAdmin = btn.classList.contains("nav-tab-admin");
    btn.classList.toggle("hidden", locked || (needsAdmin && !isAdmin));
  });
  $("#cta-learning-resources").classList.toggle("hidden", locked);
  $("#home-grid").classList.toggle("hidden", locked);
  $("#home-locked-hint").classList.toggle("hidden", !locked);
  $all(".admin-only-control").forEach((el) => el.classList.toggle("hidden", !isAdmin));
  const activeTab = $(".tab-btn.is-active")?.dataset.tab;
  const activeNeedsAdmin = activeTab === "insights" || activeTab === "admin";
  if ((locked && activeTab !== "home") || (activeNeedsAdmin && !isAdmin)) {
    switchTab("home");
  }
}

/** Shown once, before a first-time user builds their profile, so they know
 * what the role involves before answering questions about it. Skipped for
 * anyone who already has a profile (they're just editing, not deciding). */
function openRoleTutorial(role) {
  const data = ROLE_TUTORIALS[role];
  $("#role-tutorial-title").textContent = data.title;
  $("#role-tutorial-subtitle").textContent = data.subtitle;
  $("#role-tutorial-body").innerHTML = data.points
    .map((p) => `<div class="role-tutorial-point"><h4>${p.heading}</h4><p>${p.body}</p></div>`)
    .join("");
  $("#role-tutorial-continue").onclick = () => {
    closeAllModals();
    if (role === "mentor") openBecomeMentorRoleModal();
    else openBecomeMenteeRoleModal();
  };
  openModal("modal-role-tutorial");
}

function handleBecomeMentorEntry() {
  const me = getCurrentUser();
  if (!me.profileComplete) openRoleTutorial("mentor");
  else openBecomeMentorRoleModal();
}

function handleBecomeMenteeEntry() {
  const me = getCurrentUser();
  if (!me.profileComplete) openRoleTutorial("mentee");
  else openBecomeMenteeRoleModal();
}

/** AI-recommended skill chips: reads the same SKILL_CATEGORIES list used by
 * the Skills Directory article, filters out what's already typed in, and
 * lets a click append the suggestion to the field instead of typing it. */
function renderSkillSuggestions(container, category, inputEl) {
  const cat = SKILL_CATEGORIES.find((c) => c.key === category);
  if (!cat) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  const current = (inputEl.value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const suggestions = cat.examples.filter((s) => !current.includes(s.toLowerCase())).slice(0, 6);
  if (!suggestions.length) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  container.classList.remove("hidden");
  container.innerHTML =
    `<span class="skill-suggestions-label">Suggestions:</span>` +
    suggestions.map((s) => `<button type="button" class="skill-chip" data-skill="${s}">+ ${s}</button>`).join("");
  container.querySelectorAll(".skill-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const existing = (inputEl.value || "").split(",").map((s) => s.trim()).filter(Boolean);
      existing.push(chip.dataset.skill);
      inputEl.value = existing.join(", ");
      renderSkillSuggestions(container, category, inputEl);
    });
  });
}

/** Wires a skill-category <select> to its suggestion strip so picking a
 * category (or opening the modal with one already picked) refreshes the
 * chips for whichever text field that category feeds. Also attaches a
 * type-as-you-go autocomplete to the same text field. */
function wireSkillSuggestions(formEl, selectName, containerId, targetName) {
  const select = formEl.querySelector(`[name="${selectName}"]`);
  const container = document.getElementById(containerId);
  const input = formEl.querySelector(`[name="${targetName}"]`);
  if (!select || !container || !input) return;
  select.addEventListener("change", () => renderSkillSuggestions(container, select.value, input));
  attachSkillTypeahead(input, () => renderSkillSuggestions(container, select.value, input));
}

/** Type-as-you-go autocomplete for a comma-separated skill/goal field: as
 * the last (in-progress) entry is typed, suggests matching skill names
 * from across every category, not just the one currently selected. */
function attachSkillTypeahead(inputEl, onPick) {
  const label = inputEl.closest("label");
  if (!label) return;
  label.style.position = "relative";
  const menu = document.createElement("div");
  menu.className = "typeahead-menu hidden";
  label.appendChild(menu);

  function currentTags() {
    return (inputEl.value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  function renderMenu() {
    const parts = (inputEl.value || "").split(",");
    const term = parts[parts.length - 1].trim().toLowerCase();
    if (!term) {
      menu.classList.add("hidden");
      menu.innerHTML = "";
      return;
    }
    const existing = currentTags();
    const matches = ALL_SKILL_EXAMPLES.filter((s) => s.toLowerCase().includes(term) && !existing.includes(s.toLowerCase())).slice(0, 6);
    if (!matches.length) {
      menu.classList.add("hidden");
      menu.innerHTML = "";
      return;
    }
    menu.innerHTML = matches.map((s) => `<button type="button" class="typeahead-option">${s}</button>`).join("");
    menu.classList.remove("hidden");
  }

  inputEl.addEventListener("input", renderMenu);
  inputEl.addEventListener("focus", renderMenu);
  inputEl.addEventListener("blur", () => setTimeout(() => menu.classList.add("hidden"), 150));
  menu.addEventListener("mousedown", (e) => {
    const btn = e.target.closest(".typeahead-option");
    if (!btn) return;
    e.preventDefault();
    const parts = (inputEl.value || "").split(",");
    parts[parts.length - 1] = ` ${btn.textContent}`;
    inputEl.value = parts.map((p) => p.trim()).join(", ");
    menu.classList.add("hidden");
    inputEl.focus();
    if (onPick) onPick();
  });
}

function refreshSkillSuggestions(formEl, selectName, containerId, targetName) {
  const select = formEl.querySelector(`[name="${selectName}"]`);
  const container = document.getElementById(containerId);
  const input = formEl.querySelector(`[name="${targetName}"]`);
  if (!select || !container || !input) return;
  renderSkillSuggestions(container, select.value, input);
}

/** Quick tour: a handful of static steps shown once, right after someone
 * finishes building their profile for the first time. */
let walkthroughStepIndex = 0;
function openWalkthroughTour() {
  walkthroughStepIndex = 0;
  renderWalkthroughStep();
  openModal("modal-walkthrough");
}
function renderWalkthroughStep() {
  const step = WALKTHROUGH_STEPS[walkthroughStepIndex];
  $("#walkthrough-body").innerHTML = `<h3 class="tour-step-title">${step.title}</h3><p class="tour-step-body">${step.body}</p>`;
  $("#walkthrough-dots").innerHTML = WALKTHROUGH_STEPS.map((_, i) => `<span class="tour-dot ${i === walkthroughStepIndex ? "is-active" : ""}"></span>`).join("");
  $("#walkthrough-back").classList.toggle("hidden", walkthroughStepIndex === 0);
  $("#walkthrough-next").textContent = walkthroughStepIndex === WALKTHROUGH_STEPS.length - 1 ? "Done" : "Next";
}

/** Focused add-on forms, layered on top of whatever base profile onboarding already collected. */
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
  if (me.menteeCapacity) form.menteeCapacity.value = me.menteeCapacity;
  if (me.availability?.frequency) form.frequency.value = me.availability.frequency;
  if (me.availability?.hours) form.hours.value = me.availability.hours;
  form.timezone.value = me.availability?.timezone || "";
  form.consentAck.checked = !!me.consentAck;
  refreshSkillSuggestions(form, "mentorSkillCategory", "mentor-role-suggestions", "offeredSkills");
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
  if (me.availability?.hours) form.hours.value = me.availability.hours;
  form.timezone.value = me.availability?.timezone || "";
  form.goalStatement.value = me.goalStatement || "";
  form.consentAck.checked = !!me.consentAck;
  refreshSkillSuggestions(form, "learningSkillCategory", "mentee-role-suggestions", "learningGoals");
  openModal("modal-become-mentee-role");
}

/* ---------------------------------------------------------------- */
/* Tabs                                                               */
/* ---------------------------------------------------------------- */
function switchTab(tab) {
  const me = getCurrentUser();
  if (!me.profileComplete && tab !== "home") tab = "home";
  if ((tab === "insights" || tab === "admin") && !me.isAdmin) tab = "home";
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
      ${avatarHTML(m)}
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

/** Pausing freezes the 12-week clock and shifts the whole remaining
 * schedule later by however long the pause lasts, instead of quietly
 * losing that time. Either participant can pause or resume. */
function isJourneyPaused(journey) {
  return !!journey.pausedAt;
}

function getJourneyEffectiveStartDate(journey) {
  const base = getJourneyStartDate(journey);
  const pausedDays = journey.pausedDays || 0;
  return pausedDays ? addDays(base, pausedDays).toISOString().slice(0, 10) : base;
}

function getJourneyReferenceDate(journey) {
  return isJourneyPaused(journey) ? new Date(`${journey.pausedAt}T00:00:00`) : new Date();
}

function toggleJourneyPause(journey) {
  if (isJourneyPaused(journey)) {
    const pausedDays = daysBetween(journey.pausedAt, new Date());
    journey.pausedDays = (journey.pausedDays || 0) + Math.max(pausedDays, 0);
    journey.pausedAt = null;
    toast(`Resumed. Your schedule shifted forward by ${pausedDays} day${pausedDays === 1 ? "" : "s"}.`, "success");
  } else {
    journey.pausedAt = new Date().toISOString().slice(0, 10);
    const cancelledCount = cancelUpcomingMeetings(journey, "This relationship is paused. Resume it to schedule again.");
    toast(
      cancelledCount
        ? `Paused. ${cancelledCount} upcoming calendar invite${cancelledCount === 1 ? "" : "s"} cancelled automatically; download the cancellation file${cancelledCount === 1 ? "" : "s"} from My Journey to clear ${cancelledCount === 1 ? "it" : "them"} off your calendar.`
        : "Paused. Resume whenever both of you are ready to pick back up.",
      "success"
    );
  }
  savePersisted(STORAGE.journeys, journeys);
  renderJourney();
  renderActiveJourneyCard();
}

function renderActiveJourneyCard() {
  const card = $("#active-journey-card");
  const journey = findActiveJourneyFor(CURRENT_USER_ID);
  if (!journey) {
    card.innerHTML = `
      <p class="muted small">No active journey yet. Start one from the Directory or by becoming a mentor.</p>
      <button class="btn btn-primary btn-sm" data-action="goto-directory">Find a mentor</button>`;
    return;
  }
  const partner = getEmployeeById(getPartnerId(journey, CURRENT_USER_ID));
  const completed = journey.sessions.filter((s) => s.completed).length;
  const progress = clamp(completed / 5, 0, 1);
  const stageIndex = clamp(completed, 0, PROGRAM_META.stages.length - 1);
  const stage = PROGRAM_META.stages[stageIndex];
  const startDate = getJourneyEffectiveStartDate(journey);
  const weekNumber = weekNumberFor(startDate, getJourneyReferenceDate(journey));
  const paused = isJourneyPaused(journey);
  const lastSession = journey.sessions.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
  const upcomingMeeting = (journey.meetings || [])
    .filter((m) => m.status === "scheduled" && new Date(m.startISO) > new Date())
    .sort((a, b) => a.startISO.localeCompare(b.startISO))[0];

  const nextAction = paused
    ? "Paused. Resume from My Journey when you're both ready."
    : upcomingMeeting
    ? `Scheduled: ${meetingTimeLabel(upcomingMeeting.startISO)}`
    : completed === 0
    ? `Schedule your first conversation: ${stage.label.toLowerCase()} is up first.`
    : completed >= 5
    ? journey.reflection
      ? "All five conversations logged, reflection submitted."
      : "All five conversations logged. Complete your final reflection."
    : `Next up: your ${stage.label.toLowerCase()} conversation. Nothing on the calendar yet.`;

  card.innerHTML = `
    <div class="journey-summary">
      <div>
        <div class="journey-partner">With ${partner ? partner.displayName : "—"}</div>
        <div class="journey-type">${journey.relationshipType} · Week ${weekNumber} of 12${paused ? ` <span class="chip chip--paused">Paused</span>` : ""}</div>
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
      <p class="muted small">You haven't shared what you want to learn or can offer yet. That's what powers your match scores.</p>
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
        : `<p class="muted small" style="margin-top:10px">No active journey yet. Your progress will track here once you're matched.</p>`
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
          ${avatarHTML(e)}
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
  const existing = hasOpenJourneyBetween(CURRENT_USER_ID, candidateId);
  const candidateBusy = isAtCapacity(candidateId);
  const meBusy = isAtCapacity(CURRENT_USER_ID);

  const body = $("#match-modal-body");
  body.innerHTML = `
    <div class="mentor-row" style="margin-bottom:4px">
      ${avatarHTML(candidate)}
      <div class="mentor-row-info">
        <div class="mentor-row-name">${candidate.displayName}</div>
        <div class="mentor-row-meta">${candidate.department} · ${candidate.geography} · ${formatLabel(candidate.preferredFormat)}</div>
      </div>
    </div>
    <p class="match-verdict">${scoreVerdict(total)}</p>
    <p class="muted small" style="margin:2px 0 -2px">Why we think so:</p>
    <ul class="tip-list">${reasons.map((r) => `<li>${r}</li>`).join("")}</ul>
    <p class="muted small">Use this as a starting point for a conversation, not a verdict; the reasons above matter more than the number below.</p>
    <details class="score-details">
      <summary>Score breakdown</summary>
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
        ? `<p class="muted small">You're already connected. Head to My Journey to get started.</p>`
        : meBusy
        ? `<p class="muted small">You already have an active journey. You'll need a rematch before starting a new one.</p>`
        : candidateBusy
        ? `<p class="muted small">${candidate.displayName} ${candidate.preferredFormat === "mentor" && candidate.menteeCapacity ? "is at capacity right now" : "already has an active journey right now"}.</p>`
        : `<button class="btn btn-primary" id="btn-send-request">Connect now</button>
           <p class="muted small" style="margin-top:6px">This connects you right away, no approval needed. People Development can review it anytime and step in if something looks off.</p>`
    }
  `;

  openModal("modal-match");
  const sendBtn = $("#btn-send-request");
  if (sendBtn) sendBtn.addEventListener("click", () => sendRequest(candidateId, total, breakdown));
}

/** Connections form immediately on request, no admin approval gate. Admin can
 * still review any active connection and end it (no-fault rematch) at any time;
 * that's the guardrail, not a pre-approval step. */
function sendRequest(candidateId, total, breakdown) {
  const candidate = getEmployeeById(candidateId);
  const me = getCurrentUser();

  const fromBusy = isAtCapacity(CURRENT_USER_ID);
  const toBusy = isAtCapacity(candidateId);
  if (fromBusy || toBusy) {
    const busyName = fromBusy ? me.displayName : candidate.displayName;
    toast(`${busyName} ${fromBusy ? "would need a rematch before starting a new relationship" : "is at capacity right now"}.`, "error");
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
    pausedAt: null,
    pausedDays: 0,
  });
  if (candidate.menteeCount != null) candidate.menteeCount += 1;

  savePersisted(STORAGE.requests, requests);
  savePersisted(STORAGE.journeys, journeys);
  toast(`You're connected with ${candidate.displayName}. Head to My Journey to schedule your first conversation.`, "success");
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
          <div class="session-item-notes">Cancelled, still needs to be cleared from your real calendar.</div>
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
    $("#btn-toggle-pause").classList.add("hidden");
    $("#journey-pause-banner").classList.add("hidden");
    renderJourneyCleanup();
    return;
  }
  $("#journey-cleanup").classList.add("hidden");
  empty.classList.add("hidden");
  content.classList.remove("hidden");

  const partner = getEmployeeById(getPartnerId(journey, CURRENT_USER_ID));
  const realStartDate = getJourneyStartDate(journey);
  const startDate = getJourneyEffectiveStartDate(journey);
  const completed = journey.sessions.filter((s) => s.completed).length;
  const currentIndex = clamp(completed, 0, PROGRAM_META.stages.length - 1);
  const weekNumber = weekNumberFor(startDate, getJourneyReferenceDate(journey));
  const paused = isJourneyPaused(journey);

  const allMine = findActiveJourneysFor(CURRENT_USER_ID);
  const extraCount = allMine.length - 1;
  $("#journey-subtitle").textContent =
    `With ${partner ? partner.displayName : "your partner"} · Week ${weekNumber} of 12 · started ${formatDateShort(
      new Date(`${realStartDate}T00:00:00`)
    )}, wraps up around ${pilotEndDate(startDate)}.` +
    (extraCount > 0 ? ` You also have ${extraCount} other active mentee${extraCount === 1 ? "" : "s"}; this shows the most recent.` : "");

  const pauseBtn = $("#btn-toggle-pause");
  pauseBtn.classList.remove("hidden");
  pauseBtn.textContent = paused ? "Resume relationship" : "Pause relationship";
  pauseBtn.className = `btn btn-sm ${paused ? "btn-primary" : "btn-secondary"}`;
  pauseBtn.id = "btn-toggle-pause";

  const banner = $("#journey-pause-banner");
  if (paused) {
    banner.classList.remove("hidden");
    banner.textContent = `Paused since ${formatDateShort(new Date(`${journey.pausedAt}T00:00:00`))}. Meetings are on hold, and the whole schedule will shift forward by however long you're paused once you resume.`;
  } else {
    banner.classList.add("hidden");
  }

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
    : `<p class="empty-state">No sessions logged yet. Log your first conversation once you've met.</p>`;

  const pulseEligible = completed >= 2;
  const pulseBtn = $("#btn-open-pulse");
  const pulseStatus = $("#pulse-status");
  if (journey.pulse) {
    pulseStatus.textContent = `Submitted${journey.pulse.submittedAt ? ` ${daysAgoLabel(journey.pulse.submittedAt)}` : ""}. You can update it any time.`;
    pulseBtn.textContent = "Update pulse check";
    pulseBtn.disabled = false;
  } else if (!pulseEligible) {
    pulseStatus.textContent = `Unlocks after your 2nd conversation (${completed} of 2 logged so far).`;
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
    reflectionStatus.textContent = `Submitted${journey.reflection.submittedAt ? ` ${daysAgoLabel(journey.reflection.submittedAt)}` : ""}. You chose to ${OUTCOME_LABELS[journey.outcome] || "continue"}.`;
    reflectionBtn.textContent = "View final reflection";
  } else if (completed < 4) {
    reflectionStatus.textContent = `${completed} of 4 conversations logged, ${4 - completed} more to unlock.`;
    reflectionBtn.textContent = "Complete final reflection";
  } else {
    reflectionStatus.textContent = "Unlocked, ready when you are.";
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
    container.innerHTML = `<p class="empty-state">Nothing scheduled yet. Create an invite so it lands on both calendars.</p>`;
    return;
  }

  const rows = upcoming.map((m) => {
    const stage = PROGRAM_META.stages.find((s) => s.key === m.stage);
    const isPast = new Date(m.startISO) < now;
    return `
      <div class="session-item">
        <div class="session-item-head"><span>${stage ? stage.label : m.stage} conversation</span><span class="muted small">${meetingTimeLabel(m.startISO)}</span></div>
        <div class="session-item-notes">${isPast ? "This time has passed. Log it in your conversation log, or cancel it below." : "Invite sent to both calendars."}</div>
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
        <div class="session-item-head"><span>${stage ? stage.label : m.stage} conversation (cancelled)</span><span class="muted small">${meetingTimeLabel(m.startISO)}</span></div>
        <div class="session-item-notes">Removed from GainForward. Download the cancellation file to also remove it from your calendar.</div>
        <div class="match-actions" style="margin-top:8px">
          <button class="btn btn-ghost btn-sm" data-action="download-cancel-ics" data-id="${m.id}">Download cancellation (.ics)</button>
        </div>
      </div>`;
    })
  );

  container.innerHTML = rows.join("");
}

/** Turns a scheduled meeting into a real CANCEL .ics: same UID, bumped SEQUENCE, per RFC 5545. */
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

/** Auto-cancels every not-yet-occurred meeting on a journey; called the instant a relationship ends. */
function cancelUpcomingMeetings(journey, reasonText) {
  const now = new Date();
  const toCancel = (journey.meetings || []).filter((m) => m.status === "scheduled" && new Date(m.startISO) > now);
  toCancel.forEach((m) => cancelMeeting(journey, m, reasonText));
  return toCancel.length;
}

/* ---------------------------------------------------------------- */
/* Nudges: manual email reminders for mentor, mentee, or PD          */
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
    body = `Hi ${firstName},\n\nJust a quick reminder about our ${stage ? stage.label.toLowerCase() : upcoming.stage} conversation, ${meetingTimeLabel(upcoming.startISO)}. Let me know if the time still works.\n\n${me.fullName}`;
  } else if (journey) {
    subject = "Checking in on GainForward";
    body = `Hi ${firstName},\n\nJust checking in on our mentoring journey, would you like to schedule our next conversation?\n\n${me.fullName}`;
  } else {
    subject = "GainForward: following up";
    body = `Hi ${firstName},\n\nFollowing up on GainForward. Let us know if there's anything you need to get started.\n\n${me.fullName}`;
  }

  pendingNudge = { toId: recipientId, subject };
  $("#nudge-to-line").textContent = recipient.email ? `To: ${recipient.displayName} · ${recipient.email}` : `${recipient.displayName} doesn't have an email on file yet. Add one to their profile first.`;
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
/** Not a pre-approval gate; connections are already live by the time they show up
 * here. This is PD's guardrail: review why the system paired two people, and end
 * (no-fault rematch) a connection at any point if something looks off. */
function renderMatchingQueue() {
  const container = $("#matching-queue");
  const search = ($("#matching-queue-search").value || "").trim().toLowerCase();
  let activeJourneys = journeys.filter((j) => j.formalStatus === "active");

  if (!activeJourneys.length) {
    container.innerHTML = `<p class="empty-state">No active connections yet. New ones form automatically from the Directory and will show up here for review.</p>`;
    return;
  }

  if (search) {
    activeJourneys = activeJourneys.filter((j) => {
      const from = getEmployeeById(j.participantA);
      const to = getEmployeeById(j.participantB);
      return `${from?.displayName || ""} ${to?.displayName || ""}`.toLowerCase().includes(search);
    });
    if (!activeJourneys.length) {
      container.innerHTML = `<p class="empty-state">No active connections match "${search}".</p>`;
      return;
    }
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
      const allJourneys = findActiveJourneysFor(e.id);
      const journey = allJourneys[0] || null;
      const partner = journey ? getEmployeeById(getPartnerId(journey, e.id)) : null;
      const extraCount = allJourneys.length - 1;
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
        <td>${partner ? `${partner.displayName}${extraCount > 0 ? ` <span class="muted small">+${extraCount} more</span>` : ""}` : "—"}</td>
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
      ? `No-fault rematch recorded. ${cancelledCount} upcoming calendar invite${cancelledCount === 1 ? "" : "s"} cancelled automatically. Download the cancellation file${cancelledCount === 1 ? "" : "s"} from My Journey to clear ${cancelledCount === 1 ? "it" : "them"} off your calendar.`
      : "No-fault rematch recorded. Both participants can now find a new match.",
    "success"
  );
  renderAdmin();
  renderJourney();
  renderHome();
}

function renderAdmin() {
  renderMatchingQueue();
  renderRoster();
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
      <p class="muted small">Available on Delta. Search the title there to add it to your learning plan.</p>
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
/* Ask GainForward: rule-based assistant                              */
/* Answers strictly from content already in RESOURCE_LIBRARY /        */
/* SKILL_CATEGORIES — no external calls, so there's no API key to     */
/* protect. Matching is plain keyword overlap, not real NLP.          */
/* ---------------------------------------------------------------- */
let CHAT_KNOWLEDGE_BASE = null;

// Generic question words that appear in almost every entry and would
// otherwise drown out the words that actually distinguish one answer
// from another (e.g. "how", "does", "my").
const CHAT_STOPWORDS = new Set([
  "how", "what", "when", "where", "why", "who", "which", "does", "do", "did", "is", "are", "was", "were",
  "can", "could", "should", "would", "the", "a", "an", "to", "of", "for", "and", "or", "in", "on", "at",
  "my", "your", "you", "i", "me", "it", "this", "that", "these", "those", "about", "with", "from", "if",
]);

function chatTokenize(text) {
  return normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !CHAT_STOPWORDS.has(w));
}

/* Each entry has a short `primary` phrase (the question/heading/label a
   user's own words are most likely to echo) and a longer `secondary` text
   (the fuller content). Primary matches count for more, so a query that
   closely matches an entry's own question wins over one that just happens
   to share incidental words with a long, unrelated answer. */
function buildChatKnowledgeBase() {
  const kb = [];
  RESOURCE_LIBRARY.faqs.forEach((f) => kb.push({ a: f.a, primary: f.q, secondary: f.a }));
  ["bestPractices", "mentorTips", "menteeTips"].forEach((key) => {
    RESOURCE_LIBRARY[key].sections.forEach((s) => kb.push({ a: s.body, primary: s.heading, secondary: s.body }));
  });
  kb.push({
    a: `Do: ${RESOURCE_LIBRARY.dos.join("; ")}. Don't: ${RESOURCE_LIBRARY.donts.join("; ")}.`,
    primary: "do's and don'ts rules etiquette",
    secondary: `${RESOURCE_LIBRARY.dos.join(" ")} ${RESOURCE_LIBRARY.donts.join(" ")}`,
  });
  RESOURCE_LIBRARY.makingTheMost.phases.forEach((p) => kb.push({ a: p.tip, primary: `${p.phase} of a conversation`, secondary: p.tip }));
  SKILL_CATEGORIES.forEach((c) => kb.push({ a: `${c.description} Examples: ${c.examples.join(", ")}.`, primary: `${c.key} skill category`, secondary: `${c.description} ${c.examples.join(" ")}` }));
  kb.push({ a: "Go to Directory, browse or search by name, goal, or skill, and open a card to see your match score and connect. Connecting forms the relationship right away, no approval needed.", primary: "find a mentor in the directory", secondary: "search browse connect match score" });
  kb.push({ a: "Go to My Journey and use \"Schedule a conversation\" to create a calendar invite (.ics, Google, or Outlook) with reminders.", primary: "schedule a conversation or meeting", secondary: "calendar invite booking reminders" });
  kb.push({ a: "From My Journey (or the Admin console if you're an admin), use the rematch option. It's no-fault, no explanation required.", primary: "end a connection or request a rematch", secondary: "stop pause quit leave the relationship" });
  kb.push({ a: "Open your avatar menu in the top right and choose \"My profile\" to update what you're learning, offering, your availability, or your capacity.", primary: "edit or update my profile, hours, or frequency", secondary: "change settings capacity availability" });
  kb.push({ a: "You're signed out automatically after an hour with no activity, as a security precaution. Just log back in with your same credentials.", primary: "why was I signed out or logged out", secondary: "session timeout inactive expire" });
  return kb;
}

function answerChatQuestion(question) {
  if (!CHAT_KNOWLEDGE_BASE) CHAT_KNOWLEDGE_BASE = buildChatKnowledgeBase();
  const queryWords = chatTokenize(question);
  if (!queryWords.length) return null;
  let best = null;
  let bestScore = 0;
  CHAT_KNOWLEDGE_BASE.forEach((entry) => {
    const primaryWords = new Set(chatTokenize(entry.primary));
    const secondaryWords = new Set(chatTokenize(entry.secondary || ""));
    let score = 0;
    queryWords.forEach((w) => {
      if (primaryWords.has(w)) score += 3;
      else if (secondaryWords.has(w)) score += 1;
    });
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  });
  return bestScore > 0 ? best : null;
}

const CHAT_SUGGESTIONS = [
  "How long does a mentoring relationship last?",
  "What if we aren't clicking?",
  "How do I schedule a conversation?",
  "What's Career Development as a skill category?",
];

function renderChatSuggestions() {
  $("#chat-suggestions").innerHTML = CHAT_SUGGESTIONS.map((q) => `<button type="button" class="chat-suggestion-chip">${q}</button>`).join("");
}

function appendChatMessage(text, who) {
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = `chat-msg chat-msg--${who}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function handleChatQuestion(question) {
  appendChatMessage(question, "user");
  const match = answerChatQuestion(question);
  appendChatMessage(
    match ? match.a : "I don't have a good answer for that yet. Try Learning Resources, or reach out to People Development directly.",
    "bot"
  );
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
      ? `AI source failed (${dataSourceInfo.error || "unknown error"}), showing demo roster`
      : "Showing demo roster, configure your AI data source";
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

/** Identity comes from the demo login, not the seed data; inject the logged-in persona here. */
/** All 5 demo personas are always real, visible employees, not just the one
 * currently logged in, so admin/roster/journeys involving any of them render
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
      menteeCapacity: null,
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
    $("#login-timeout-note").classList.add("hidden");
    localStorage.setItem(STORAGE.activeDemoUser, account.id);
    e.target.reset();
    startApp();
  });

  $all(".tab-btn").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

  wireSkillSuggestions($("#form-become-mentor"), "learningSkillCategory", "profile-learning-suggestions", "learningGoals");
  wireSkillSuggestions($("#form-become-mentor"), "mentorSkillCategory", "profile-offering-suggestions", "offeredSkills");
  wireSkillSuggestions($("#form-become-mentor-role"), "mentorSkillCategory", "mentor-role-suggestions", "offeredSkills");
  wireSkillSuggestions($("#form-become-mentee-role"), "learningSkillCategory", "mentee-role-suggestions", "learningGoals");

  $("#walkthrough-next").addEventListener("click", () => {
    if (walkthroughStepIndex >= WALKTHROUGH_STEPS.length - 1) {
      closeAllModals();
      return;
    }
    walkthroughStepIndex++;
    renderWalkthroughStep();
  });
  $("#walkthrough-back").addEventListener("click", () => {
    if (walkthroughStepIndex === 0) return;
    walkthroughStepIndex--;
    renderWalkthroughStep();
  });

  $("#chat-fab").addEventListener("click", () => {
    const panel = $("#chat-panel");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden") && !$("#chat-suggestions").childElementCount) {
      renderChatSuggestions();
    }
  });
  $("#chat-close").addEventListener("click", () => $("#chat-panel").classList.add("hidden"));
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-input");
    const question = input.value.trim();
    if (!question) return;
    handleChatQuestion(question);
    input.value = "";
  });
  $("#chat-suggestions").addEventListener("click", (e) => {
    const btn = e.target.closest(".chat-suggestion-chip");
    if (!btn) return;
    handleChatQuestion(btn.textContent);
  });

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
        handleBecomeMentorEntry();
        break;
      case "open-become-mentee-role":
        handleBecomeMenteeEntry();
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
      case "close-walkthrough":
        closeAllModals();
        break;
      case "open-settings":
        $("#user-menu").classList.add("hidden");
        if (getCurrentUser().isAdmin) openSettingsModal();
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
      case "toggle-pause": {
        const journey = findActiveJourneyFor(CURRENT_USER_ID);
        if (journey) toggleJourneyPause(journey);
        break;
      }
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
        toast("Data source cleared, back to the demo roster.");
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
  $("#matching-queue-search").addEventListener("input", renderMatchingQueue);

  $("#profile-photo-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      pendingPhotoUrl = await resizeImageToDataURL(file, 200);
      applyAvatarVisual($("#profile-photo-preview"), { photoUrl: pendingPhotoUrl, avatarInitials: getCurrentUser().avatarInitials });
      $("#profile-photo-remove").classList.remove("hidden");
    } catch {
      toast("Couldn't read that image. Try a different file.", "error");
    }
  });
  $("#profile-photo-remove").addEventListener("click", () => {
    pendingPhotoUrl = null;
    $("#profile-photo-input").value = "";
    applyAvatarVisual($("#profile-photo-preview"), { photoUrl: null, avatarInitials: getCurrentUser().avatarInitials });
    $("#profile-photo-remove").classList.add("hidden");
  });

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
      menteeCapacity: Number(fd.get("menteeCapacity")) || 1,
      goalStatement: fd.get("goalStatement").trim(),
      purpose: fd.get("purpose").trim(),
      preferredFormat: fd.get("preferredFormat"),
      aiConfidence: fd.get("aiConfidence"),
      availability: { ...me.availability, frequency: fd.get("frequency"), hours: Number(fd.get("hours")) || 1, timezone: fd.get("timezone").trim() || "—" },
      matchNote: fd.get("matchNote").trim(),
      photoUrl: pendingPhotoUrl === undefined ? me.photoUrl : pendingPhotoUrl,
    };

    saveCurrentUserProfile(fields);
    isOnboarding = false;

    toast(wasOnboarding ? `Welcome, ${displayName}. Your profile is set up.` : "Profile updated.", "success");
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
    const wasComplete = me.profileComplete;
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
      menteeCapacity: Number(fd.get("menteeCapacity")) || 1,
      availability: { ...me.availability, frequency: fd.get("frequency"), hours: Number(fd.get("hours")) || 1, timezone: fd.get("timezone").trim() || "—" },
      consentAck: fd.get("consentAck") === "on",
      preferredFormat: "mentor",
      engagementStatus: me.engagementStatus === "closed" ? "available" : me.engagementStatus,
      profileComplete: true,
    });
    toast("You're set up as a mentor. You'll now show up in the Directory.", "success");
    closeAllModals();
    renderUserChrome();
    populateFilterDropdowns();
    renderDirectory();
    renderHome();
    if (!wasComplete) openWalkthroughTour();
  });

  $("#form-become-mentee-role").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const me = getCurrentUser();
    const wasComplete = me.profileComplete;
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
      availability: { ...me.availability, frequency: fd.get("frequency"), hours: Number(fd.get("hours")) || 1, timezone: fd.get("timezone").trim() || "—" },
      goalStatement: fd.get("goalStatement").trim(),
      consentAck: fd.get("consentAck") === "on",
      preferredFormat: "mentee",
      engagementStatus: me.engagementStatus === "closed" ? "available" : me.engagementStatus,
      profileComplete: true,
    });
    toast("You're set up as a mentee. Let's find you a mentor.", "success");
    closeAllModals();
    renderUserChrome();
    populateFilterDropdowns();
    renderHome();
    if (!wasComplete) openWalkthroughTour();
    else switchTab("directory");
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
    const description = `${stage ? stage.detail : ""}\n\nScheduled from GainForward: ${journey.relationshipType}.`;
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
      location: "Video call (link shared separately)",
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

    $("#schedule-result-summary").textContent = `Invite ready for your ${stage ? stage.label.toLowerCase() : stageKey} conversation, ${meetingTimeLabel(start.toISOString())}.`;
    $("#schedule-result-note").textContent = partner?.email
      ? `The .ics download carries reminders 1 day and 30 minutes before. The one-click Google/Outlook links use each calendar's own default reminder instead; they don't support custom alarms.`
      : `We couldn't find an email for ${partner ? partner.displayName : "your partner"}, so only you're listed as an attendee. Add them manually once it's on your calendar.`;
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
    toast("Pulse check submitted. Thanks for the honest signal.", "success");
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
        ? `Final reflection submitted. ${cancelledCount} upcoming calendar invite${cancelledCount === 1 ? "" : "s"} cancelled automatically. Download the cancellation file below to clear ${cancelledCount === 1 ? "it" : "them"} off your calendar.`
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
      result.textContent = `Connected: received ${list.length} employee record${list.length === 1 ? "" : "s"}.`;
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
  $("#chat-fab").classList.add("hidden");
  $("#chat-panel").classList.add("hidden");
}

async function startApp() {
  $("#login-screen").classList.add("hidden");
  await refreshEmployeeSource();
  ensureJourneysSeeded();
  ensureMeetingsField();
  renderUserChrome();
  renderHome();
  markActivity();
  $("#chat-fab").classList.remove("hidden");
  // Home CTAs handle sign-up; applyAccessGate() (inside renderUserChrome)
  // locks the rest of the app down until a profile exists.
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

/* ---------------------------------------------------------------- */
/* Session idle timeout: signs out after an hour of no activity      */
/* ---------------------------------------------------------------- */
const IDLE_LIMIT_MS = 60 * 60 * 1000;
let lastActivityAt = Date.now();
function markActivity() {
  lastActivityAt = Date.now();
}
["mousemove", "keydown", "click", "scroll", "touchstart"].forEach((evt) => document.addEventListener(evt, markActivity, { passive: true }));
setInterval(() => {
  if (!CURRENT_USER_ID) return;
  if (Date.now() - lastActivityAt < IDLE_LIMIT_MS) return;
  localStorage.removeItem(STORAGE.activeDemoUser);
  CURRENT_USER_ID = null;
  $("#login-timeout-note").classList.remove("hidden");
  showLoginScreen();
}, 60 * 1000);

/* ---------------------------------------------------------------- */
/* Employee data sync: re-pulls from the configured source (or seed) */
/* every 2 hours, for any tab left open that long                    */
/* ---------------------------------------------------------------- */
const DATA_SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000;
setInterval(async () => {
  if (!CURRENT_USER_ID) return;
  await refreshEmployeeSource();
  renderHome();
  const activeTab = $(".tab-btn.is-active")?.dataset.tab;
  if (activeTab === "directory") renderDirectory();
  if (activeTab === "journey") renderJourney();
  if (activeTab === "insights") renderInsights();
  if (activeTab === "admin") renderAdmin();
}, DATA_SYNC_INTERVAL_MS);

init();
