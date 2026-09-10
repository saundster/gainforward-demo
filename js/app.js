/* Click: app logic (tabs, forms, matching, journeys, insights, admin). */

const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STORAGE = {
  requests: "gainforward.requests",
  journeys: "gainforward.journeys",
  addedEmployees: "gainforward.addedEmployees",
  overrides: "gainforward.employeeOverrides",
  nudges: "gainforward.nudges",
  activeDemoUser: "gainforward.activeDemoUser",
  adminLog: "gainforward.adminLog",
  proxy: "gainforward.proxySession",
};

let CURRENT_USER_ID = null;
let employees = [];
let requests = loadPersisted(STORAGE.requests, []);
let journeys = loadPersisted(STORAGE.journeys, null); // null = not yet seeded this browser
let nudges = loadPersisted(STORAGE.nudges, []);
let adminLog = loadPersisted(STORAGE.adminLog, []);
let dataSourceInfo = { source: "seed" };

/** A Super Admin viewing the app as someone else: { adminId, targetId }.
 * Kept in sessionStorage (not localStorage) so it's scoped to this tab and
 * never survives closing the browser, but does survive an accidental reload. */
let PROXY = null;
function restoreProxySession() {
  try {
    const raw = sessionStorage.getItem(STORAGE.proxy);
    PROXY = raw ? JSON.parse(raw) : null;
  } catch {
    PROXY = null;
  }
}
function persistProxySession() {
  if (PROXY) sessionStorage.setItem(STORAGE.proxy, JSON.stringify(PROXY));
  else sessionStorage.removeItem(STORAGE.proxy);
}

/** Wipes every piece of this browser's demo state (journeys, requests, nudges,
 * roster overrides, admin log, the signed-in account) back to a clean slate,
 * since there's no backend to reset it from and a rematch/status change has
 * no other way to undo. Reachable from the login screen (signed out) and the
 * account dropdown (signed in), since either can be the one who needs it. */
function resetDemoData() {
  Object.values(STORAGE).forEach((key) => localStorage.removeItem(key));
  sessionStorage.removeItem(STORAGE.proxy);
  location.reload();
}

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
/** Two admin tiers: Admin (full view + export + nudging + status edits) and
 * Super Admin (all of that, plus ending a relationship on someone else's
 * behalf and proxying into another account). */
function isAdminUser(me) {
  return me.adminRole === "admin" || me.adminRole === "superadmin";
}
function isSuperAdminUser(me) {
  return me.adminRole === "superadmin";
}
function roleLabel(me) {
  if (me.adminRole === "superadmin") return "Super Admin";
  if (me.adminRole === "admin") return "Admin";
  return "";
}

/** Lightweight, visible record of who did what with elevated access (ending
 * a relationship on someone else's behalf, proxying into an account), so
 * Admins can see it happened even though only Super Admin can trigger it. */
function logAdminAction(message, actorId) {
  const actor = getEmployeeById(actorId || CURRENT_USER_ID);
  adminLog.unshift({ id: uid("log"), ts: new Date().toISOString(), actorName: actor?.displayName || "Someone", message });
  adminLog = adminLog.slice(0, 50);
  savePersisted(STORAGE.adminLog, adminLog);
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

/** Generic yes/cancel confirmation, reused for any destructive action
 * (right now just ending a relationship) instead of a one-off modal each time. */
let pendingConfirmAction = null;
function openConfirmModal({ title, body, confirmLabel = "Confirm", danger = false }, onConfirm) {
  pendingConfirmAction = onConfirm;
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = body;
  const btn = $("#confirm-yes");
  btn.textContent = confirmLabel;
  btn.className = `btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`;
  openModal("modal-confirm");
}

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
  applyIdentityLock(form, me);
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
  form.deliveryFormat.value = me.deliveryFormat || "";
  form.preferredLanguage.value = me.preferredLanguage || "";
  form.matchNote.value = me.matchNote || "";
  form.consentAck.checked = !!me.consentAck;

  // Sign-up builds the full profile in one go; this is the only place all of
  // this is asked, so there's nothing left to fill in piecemeal later.
  $("#profile-modal-title").textContent = onboarding ? "Welcome to Click, let's build your profile" : "Your profile";
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

/** Simulates SSO/HRIS-sourced identity: hides name/email/department/region
 * once the account already has that data, since there's nothing for people
 * to do with fields that just repeat their own information back to them.
 * A real deploy would populate these from the identity provider on login;
 * there's no backend here to do that, so this only hides what's already on
 * the account (a brand-new demo persona with nothing on file sees and fills
 * in the fields itself). */
function applyIdentityLock(form, me) {
  const known = !!(me.fullName && me.email && me.department && me.geography);
  const block = form.querySelector(".identity-block");
  if (block) block.classList.toggle("hidden", known);
}

function renderUserChrome() {
  const me = getCurrentUser();
  applyAvatarVisual($("#user-avatar-btn"), me);
  applyAvatarVisual($("#dropdown-avatar"), me);
  $("#dropdown-name").textContent = me.fullName || "Your name";
  $("#dropdown-role").textContent = me.profileComplete ? `${me.department || "—"} · ${me.geography || "—"}` : "Profile not set up yet";
  const badge = $("#dropdown-role-badge");
  const label = roleLabel(me);
  badge.textContent = label;
  badge.classList.toggle("hidden", !label);
  badge.classList.toggle("chip--superadmin", me.adminRole === "superadmin");
  badge.classList.toggle("chip--admin", me.adminRole === "admin");
  applyAccessGate();
  renderProxyBanner();
}

/** Before a profile exists, a new user can only pick a role, nothing else,
 * so Home and the nav don't show sections that don't mean anything yet. */
function applyAccessGate() {
  const me = getCurrentUser();
  const locked = !me.profileComplete;
  const isAdmin = isAdminUser(me);
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
let roleTutorialRole = null;
let roleTutorialStepIndex = 0;

function openRoleTutorial(role) {
  roleTutorialRole = role;
  roleTutorialStepIndex = 0;
  const data = ROLE_TUTORIALS[role];
  $("#role-tutorial-title").textContent = data.title;
  $("#role-tutorial-subtitle").textContent = data.subtitle;
  renderRoleTutorialStep();
  openModal("modal-role-tutorial");
}

function renderRoleTutorialStep() {
  const data = ROLE_TUTORIALS[roleTutorialRole];
  const point = data.points[roleTutorialStepIndex];
  $("#role-tutorial-body").innerHTML = `<div class="role-tutorial-point"><h4>${point.heading}</h4><p>${point.body}</p></div>`;
  $("#role-tutorial-dots").innerHTML = data.points
    .map((_, i) => `<span class="tour-dot ${i === roleTutorialStepIndex ? "is-active" : ""}"></span>`)
    .join("");
  $("#role-tutorial-back").classList.toggle("hidden", roleTutorialStepIndex === 0);
  $("#role-tutorial-next").textContent = roleTutorialStepIndex === data.points.length - 1 ? "Done" : "Next";
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
  applyIdentityLock(form, me);
  form.purpose.value = me.purpose || "";
  if (me.mentorSkillCategory) form.mentorSkillCategory.value = me.mentorSkillCategory;
  form.offeredSkills.value = (me.offeredSkills || []).join(", ");
  if (me.menteeCapacity) form.menteeCapacity.value = me.menteeCapacity;
  if (me.availability?.frequency) form.frequency.value = me.availability.frequency;
  if (me.availability?.hours) form.hours.value = me.availability.hours;
  form.timezone.value = me.availability?.timezone || "";
  form.deliveryFormat.value = me.deliveryFormat || "";
  form.preferredLanguage.value = me.preferredLanguage || "";
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
  applyIdentityLock(form, me);
  form.learningGoals.value = (me.learningGoals || []).join(", ");
  if (me.learningSkillCategory) form.learningSkillCategory.value = me.learningSkillCategory;
  if (me.skillLevel) form.skillLevel.value = me.skillLevel;
  if (me.availability?.frequency) form.frequency.value = me.availability.frequency;
  if (me.availability?.hours) form.hours.value = me.availability.hours;
  form.timezone.value = me.availability?.timezone || "";
  form.deliveryFormat.value = me.deliveryFormat || "";
  form.preferredLanguage.value = me.preferredLanguage || "";
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
  if ((tab === "insights" || tab === "admin") && !isAdminUser(me)) tab = "home";
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

/** Admin "Needs attention" triage: surfaces what the pulse-check intro
 * promises PD reviews ("to catch issues early") plus relationships that
 * have gone quiet, instead of requiring someone to open every connection
 * individually to find out if anything's wrong. */
function pulseAverageScore(pulse) {
  const vals = ["q1", "q2", "q3", "q4"].map((k) => Number(pulse[k])).filter((n) => !isNaN(n));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function getAttentionReasons(journey) {
  const reasons = [];
  if (isJourneyPaused(journey)) return reasons; // a pause is an acknowledged break, not a silent problem
  if (journey.pulse) {
    const avg = pulseAverageScore(journey.pulse);
    if (avg !== null && avg <= 2.5) reasons.push(`Pulse check averaged ${avg.toFixed(1)}/5`);
    if (journey.pulse.continuation === "no") reasons.push("Someone answered “no” to continuing");
    else if (journey.pulse.continuation === "maybe") reasons.push("Someone answered “maybe” to continuing");
  }
  const lastSession = journey.sessions.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
  const lastActivityDate = lastSession ? lastSession.date : getJourneyStartDate(journey);
  const daysSince = daysBetween(lastActivityDate, new Date());
  if (daysSince >= 21) reasons.push(`Nothing logged in ${daysSince} days`);
  return reasons;
}

function renderAttentionList() {
  const container = $("#attention-list");
  const flagged = journeys
    .filter((j) => j.formalStatus === "active")
    .map((j) => ({ journey: j, reasons: getAttentionReasons(j) }))
    .filter((f) => f.reasons.length);

  if (!flagged.length) {
    container.innerHTML = `<p class="empty-state">Nothing needs attention right now.</p>`;
    return;
  }

  container.innerHTML = flagged
    .map(({ journey: j, reasons }) => {
      const from = getEmployeeById(j.participantA);
      const to = getEmployeeById(j.participantB);
      return `
      <div class="match-item">
        <div class="match-item-head">
          <span class="match-item-pair">${from ? from.displayName : "?"} ↔ ${to ? to.displayName : "?"}</span>
        </div>
        <ul class="tip-list match-reasons">${reasons.map((r) => `<li>${r}</li>`).join("")}</ul>
        <div class="match-actions">
          <button class="btn btn-ghost btn-sm" data-action="open-nudge" data-id="${from?.id || ""}">Nudge ${from?.displayName || ""}</button>
          <button class="btn btn-ghost btn-sm" data-action="open-nudge" data-id="${to?.id || ""}">Nudge ${to?.displayName || ""}</button>
          ${isSuperAdminUser(getCurrentUser()) ? `<button class="btn btn-danger-outline btn-sm" data-action="rematch" data-id="${j.id}">End connection (rematch)</button>` : ""}
        </div>
      </div>`;
    })
    .join("");
}

/** Admin adoption tracking: who hasn't finished a profile, so PD can chase
 * completion instead of only seeing one aggregate percentage in Insights. */
function getIncompleteProfiles() {
  return employees.filter((e) => !e.profileComplete && e.id !== CURRENT_USER_ID);
}

function renderAdoptionList() {
  const container = $("#adoption-list");
  const incomplete = getIncompleteProfiles();
  $("#btn-nudge-adoption").classList.toggle("hidden", incomplete.length === 0);

  if (!incomplete.length) {
    container.innerHTML = `<p class="empty-state">Everyone in the roster has set up a profile.</p>`;
    return;
  }

  container.innerHTML = incomplete
    .map(
      (e) => `
    <div class="session-item">
      <div class="session-item-head">
        <span>${e.fullName || e.displayName || "Unnamed"}${e.department ? ` · ${e.department}` : ""}</span>
        <button class="btn btn-ghost btn-sm" data-action="open-nudge" data-id="${e.id}">Nudge</button>
      </div>
    </div>`
    )
    .join("");
}

/** Bulk nudge: one mailto draft, everyone BCC'd, since there's no backend
 * to send individual emails from. Logs one nudge entry per recipient so
 * Recent Nudges stays an accurate record of who's been reached out to. */
function sendBulkNudge(recipients, subject, body) {
  const withEmail = recipients.filter((e) => e?.email);
  if (!withEmail.length) {
    toast("Nobody in this list has an email on file to nudge.", "error");
    return;
  }
  const bcc = withEmail.map((e) => e.email).join(",");
  window.location.href = `mailto:?bcc=${encodeURIComponent(bcc)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  withEmail.forEach((e) => {
    nudges.unshift({ id: uid("nudge"), fromId: CURRENT_USER_ID, toId: e.id, message: body, sentAt: new Date().toISOString() });
  });
  savePersisted(STORAGE.nudges, nudges);
  toast(`Email draft opened — ${withEmail.length} people BCC'd.`, "success");
  renderNudgeLog();
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
      ? "All five conversations logged — reflection submitted."
      : "All five conversations logged. Complete your final reflection."
    : `Next up: your ${stage.label.toLowerCase()} conversation — not on the calendar yet.`;

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

  const suggested = recommendLearningContent(me, 1);

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
    }
    ${
      suggested.length
        ? `<div class="growth-suggested">
      <div class="growth-label">Suggested learning</div>
      ${learningContentHTML(suggested[0])}
      <button class="link-btn" data-action="open-resources">See more recommended learning ↗</button>
    </div>`
        : ""
    }`;
}

/* ---------------------------------------------------------------- */
/* Directory                                                          */
/* ---------------------------------------------------------------- */
function populateFilterDropdowns() {
  const depts = [...new Set(employees.map((e) => e.department))].filter(Boolean).sort();
  const geos = [...new Set(employees.map((e) => e.geography))].filter(Boolean).sort();
  const deptOptions = `<option value="">All departments</option>` + depts.map((d) => `<option value="${d}">${d}</option>`).join("");
  const geoOptions = `<option value="">All regions</option>` + geos.map((g) => `<option value="${g}">${g}</option>`).join("");

  [$("#filter-department"), $("#roster-filter-department")].forEach((sel) => {
    const current = sel.value;
    sel.innerHTML = deptOptions;
    if (depts.includes(current)) sel.value = current;
  });
  [$("#filter-geo"), $("#roster-filter-geo")].forEach((sel) => {
    const current = sel.value;
    sel.innerHTML = geoOptions;
    if (geos.includes(current)) sel.value = current;
  });
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
      const allSkills = e.offeredSkills && e.offeredSkills.length ? e.offeredSkills : e.learningGoals || [];
      const skillsChips = allSkills
        .slice(0, 3)
        .map((s) => `<span class="chip chip--skill">${s}</span>`)
        .join("");
      const extraSkills = allSkills.length - 3;
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
        <div class="chip-row">${skillsChips}${extraSkills > 0 ? `<span class="chip chip--skill">+${extraSkills} more</span>` : ""}</div>
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
        : `<label class="match-prep-label">Topic for your first conversation
             <input type="text" id="match-prep-topic" placeholder="e.g. Getting a first enterprise deal narrative right" />
           </label>
           <label class="match-prep-label">What have you already tried, read, or thought through on your own about this?
             <textarea id="match-prep-note" rows="2" placeholder="e.g. I've read a beginner's guide and worked through a few practice questions on my own"></textarea>
           </label>
           <p class="muted small">A little groundwork means the first conversation builds on something, instead of starting from zero. ${candidate.displayName} will see this agenda before you meet.</p>
           <button class="btn btn-primary" id="btn-send-request">Connect now</button>
           <p class="muted small" style="margin-top:6px">This connects you right away, no approval needed. People Development can review it anytime and step in if something looks off.</p>`
    }
  `;

  openModal("modal-match");
  const sendBtn = $("#btn-send-request");
  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      const topicEl = $("#match-prep-topic");
      const noteEl = $("#match-prep-note");
      const prepTopic = (topicEl?.value || "").trim();
      const prepNote = (noteEl?.value || "").trim();
      if (prepTopic.length < 3) {
        toast("Add a short topic for your first conversation.", "error");
        topicEl?.focus();
        return;
      }
      if (prepNote.length < 10) {
        toast("Add a quick note on what you've already tried or thought through; a sentence is enough.", "error");
        noteEl?.focus();
        return;
      }
      sendRequest(candidateId, total, breakdown, prepTopic, prepNote);
    });
  }
}

/** Connections form immediately on request, no admin approval gate. A Super
 * Admin can still review any active connection and end it (no-fault rematch)
 * at any time; that's the guardrail, not a pre-approval step. */
function sendRequest(candidateId, total, breakdown, prepTopic, prepNote) {
  const candidate = getEmployeeById(candidateId);
  const me = getCurrentUser();

  const fromBusy = isAtCapacity(CURRENT_USER_ID);
  const toBusy = isAtCapacity(candidateId);
  if (fromBusy || toBusy) {
    const busyName = fromBusy ? me.displayName : candidate.displayName;
    toast(`${busyName} ${fromBusy ? "would need a rematch before starting a new relationship" : "is at capacity"}.`, "error");
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
    prepTopic: prepTopic || "",
    prepNote: prepNote || "",
    prepNoteFromId: CURRENT_USER_ID,
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
          <div class="session-item-notes">Cancelled here, but still needs to be cleared from your calendar.</div>
          <div class="match-actions" style="margin-top:8px">
            <button class="btn btn-ghost btn-sm" data-action="download-cancel-ics" data-id="${m.id}">Download cancellation (.ics)</button>
          </div>
        </div>`;
      });
  });
  $("#journey-cleanup-list").innerHTML = rows.join("");
}

/** The agenda a mentee sets before connecting: a topic plus what they've
 * already looked into, so the first conversation starts from something
 * instead of "so, what do you want to talk about?" Shown on My Journey and
 * again when scheduling, so it's never buried after the connect moment. */
function agendaHTML(journey) {
  if (!journey.prepTopic && !journey.prepNote) return "";
  const isMine = journey.prepNoteFromId === CURRENT_USER_ID;
  const from = getEmployeeById(journey.prepNoteFromId);
  const who = isMine ? "you" : from?.displayName || "they";
  return `<strong>First conversation agenda</strong> <span class="muted small">(shared by ${who})</span>${
    journey.prepTopic ? `<div class="journey-agenda-topic">${journey.prepTopic}</div>` : ""
  }${journey.prepNote ? `<div>Already looked into: “${journey.prepNote}”</div>` : ""}`;
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
    $("#btn-end-connection").classList.add("hidden");
    $("#journey-pause-banner").classList.add("hidden");
    $("#journey-prep-note").classList.add("hidden");
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
    )} · wraps up around ${pilotEndDate(startDate)}.` +
    (extraCount > 0 ? ` You also have ${extraCount} other active mentee${extraCount === 1 ? "" : "s"}; this shows the most recent.` : "");

  const pauseBtn = $("#btn-toggle-pause");
  pauseBtn.classList.remove("hidden");
  pauseBtn.textContent = paused ? "Resume relationship" : "Pause relationship";
  pauseBtn.className = `btn btn-sm ${paused ? "btn-primary" : "btn-secondary"}`;
  pauseBtn.id = "btn-toggle-pause";

  const endBtn = $("#btn-end-connection");
  endBtn.classList.remove("hidden");
  endBtn.dataset.id = journey.id;

  const banner = $("#journey-pause-banner");
  if (paused) {
    banner.classList.remove("hidden");
    banner.textContent = `Paused since ${formatDateShort(new Date(`${journey.pausedAt}T00:00:00`))}. Meetings are on hold until you resume.`;
  } else {
    banner.classList.add("hidden");
  }

  const prepNoteEl = $("#journey-prep-note");
  const agenda = agendaHTML(journey);
  prepNoteEl.classList.toggle("hidden", !agenda);
  prepNoteEl.innerHTML = agenda;

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
    reflectionStatus.textContent = `${completed} of 4 conversations logged — ${4 - completed} more to unlock.`;
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
        <div class="session-item-notes">Removed from Click. Download the cancellation file to also remove it from your calendar.</div>
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
    title: `Click: ${stage ? stage.label : meeting.stage} conversation`,
    description: reasonText || "This conversation was cancelled.",
    start: new Date(meeting.startISO),
    durationMins: meeting.durationMins,
    organizer: organizer ? { name: organizer.fullName, email: organizer.email } : null,
    attendees,
  });
  meeting.cancelFilename = `click-${meeting.stage}-conversation-cancelled.ics`;
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
    subject = "Checking in on Click";
    body = `Hi ${firstName},\n\nJust checking in on our mentoring journey — would you like to schedule our next conversation?\n\n${me.fullName}`;
  } else {
    subject = "Click: following up";
    body = `Hi ${firstName},\n\nFollowing up on Click. Let us know if there's anything you need to get started.\n\n${me.fullName}`;
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
  const agendaNote = $("#schedule-agenda-note");
  const agenda = agendaHTML(journey);
  agendaNote.classList.toggle("hidden", !agenda);
  agendaNote.innerHTML = agenda;

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
 * here. This is PD's guardrail: review why the system paired two people. Only a
 * Super Admin can end (no-fault rematch) a connection from here if something
 * looks off; a plain Admin can review and nudge but not end it. */
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
          ${isSuperAdminUser(getCurrentUser()) ? `<button class="btn btn-danger-outline btn-sm" data-action="rematch" data-id="${j.id}">End connection (rematch)</button>` : ""}
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
  const dept = $("#roster-filter-department").value;
  const geo = $("#roster-filter-geo").value;
  const format = $("#roster-filter-format").value;
  const status = $("#roster-filter-status").value;
  const rows = employees.filter((e) => {
    if (dept && e.department !== dept) return false;
    if (geo && e.geography !== geo) return false;
    if (format && e.preferredFormat !== format) return false;
    if (status && e.engagementStatus !== status) return false;
    if (!search) return true;
    return `${e.fullName} ${e.department}`.toLowerCase().includes(search);
  });

  if (!rows.length) {
    $("#roster-body").innerHTML = `<tr><td colspan="7" class="empty-state">No one matches these filters.</td></tr>`;
    return;
  }

  $("#roster-body").innerHTML = rows
    .map((e) => {
      const allJourneys = findActiveJourneysFor(e.id);
      const journey = allJourneys[0] || null;
      const partner = journey ? getEmployeeById(getPartnerId(journey, e.id)) : null;
      const extraCount = allJourneys.length - 1;
      return `
      <tr>
        <td>${e.displayName}${e.id === CURRENT_USER_ID ? " (you)" : ""}${roleLabel(e) ? ` <span class="chip chip--${e.adminRole}">${roleLabel(e)}</span>` : ""}</td>
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
            ${journey && isSuperAdminUser(getCurrentUser()) ? `<button class="btn btn-ghost btn-sm" data-action="rematch" data-id="${journey.id}">Rematch</button>` : ""}
            ${e.id !== CURRENT_USER_ID && isSuperAdminUser(getCurrentUser()) ? `<button class="btn btn-ghost btn-sm" data-action="proxy-user" data-id="${e.id}">Proxy</button>` : ""}
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

/** Confirms before ending a relationship, since there's no undo. Wording
 * differs depending on whether you're ending your own relationship (My
 * Journey) or someone else's on their behalf (Admin console). */
function confirmRematch(journeyId) {
  const journey = journeys.find((j) => j.id === journeyId);
  if (!journey) return;
  const me = getCurrentUser();
  const isMine = journey.participantA === me.id || journey.participantB === me.id;
  const a = getEmployeeById(journey.participantA);
  const b = getEmployeeById(journey.participantB);
  const body = isMine
    ? "This ends your current relationship and cancels any upcoming meetings. You'll both be free to find a new match. This can't be undone."
    : `This ends the relationship between ${a?.displayName || "this participant"} and ${b?.displayName || "their partner"} and cancels any upcoming meetings. This can't be undone.`;
  openConfirmModal({ title: "End this connection?", body, confirmLabel: "End connection", danger: true }, () => triggerRematch(journeyId));
}

function triggerRematch(journeyId) {
  const journey = journeys.find((j) => j.id === journeyId);
  if (!journey) return;
  const actor = getCurrentUser();
  const isAdminAction = actor.id !== journey.participantA && actor.id !== journey.participantB;
  journey.formalStatus = "closed";
  journey.outcome = "rematch";
  const cancelledCount = cancelUpcomingMeetings(journey, "This relationship was rematched before this conversation happened.");
  savePersisted(STORAGE.journeys, journeys);
  if (isAdminAction) {
    const a = getEmployeeById(journey.participantA);
    const b = getEmployeeById(journey.participantB);
    logAdminAction(`Ended the relationship between ${a?.displayName || "someone"} and ${b?.displayName || "someone"}.`);
  }
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
  renderAttentionList();
  renderMatchingQueue();
  renderAdoptionList();
  renderRoster();
  renderNudgeLog();
  renderAdminLog();
}

function renderAdminLog() {
  const container = $("#admin-log-list");
  if (!container) return;
  if (!adminLog.length) {
    container.innerHTML = `<p class="empty-state">No admin activity yet.</p>`;
    return;
  }
  container.innerHTML = adminLog
    .slice(0, 15)
    .map(
      (entry) => `
      <div class="session-item">
        <div class="session-item-head"><span>${entry.actorName}</span><span class="muted small">${daysAgoLabel(entry.ts.slice(0, 10))}</span></div>
        <div class="session-item-notes">${entry.message}</div>
      </div>`
    )
    .join("");
}

/* ---------------------------------------------------------------- */
/* Resources modal                                                    */
/* ---------------------------------------------------------------- */
const RESOURCE_TABS = [
  { key: "recommended", label: "Recommended for you" },
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
  const me = getCurrentUser();
  currentResourceTab = me.learningGoals?.length ? "recommended" : "faqs";
  renderResourceTabs();
  renderResourcePanel();
}

/** One provider pick (LinkedIn Learning course or YouTube video) as a card.
 * Content only ever comes from the curated LEARNING_CONTENT library, never
 * a live API call, so every link is one we've verified by hand. */
function learningPickHTML(pick) {
  return `
    <div class="course-card">
      <span class="chip chip--skill">${pick.provider}</span>
      <div class="course-title">${pick.title}</div>
      <div class="course-meta">${pick.meta}</div>
      <a class="course-link" href="${pick.url}" target="_blank" rel="noopener">Open ↗</a>
    </div>`;
}

function learningContentHTML(entry) {
  const picks = [];
  if (entry.linkedin) picks.push({ provider: "LinkedIn Learning", title: entry.linkedin.title, meta: entry.linkedin.instructor, url: entry.linkedin.url });
  if (entry.youtube) picks.push({ provider: "YouTube", title: entry.youtube.title, meta: entry.youtube.channel, url: entry.youtube.url });
  return picks.map(learningPickHTML).join("");
}

function renderResourceTabs() {
  $("#resource-tabs").innerHTML = RESOURCE_TABS.map(
    (t) => `<button class="resource-tab-btn ${t.key === currentResourceTab ? "is-active" : ""}" data-action="switch-resource-tab" data-key="${t.key}">${t.label}</button>`
  ).join("");
}

function renderResourcePanel() {
  const panel = $("#resource-panel");
  const key = currentResourceTab;

  if (key === "recommended") {
    const me = getCurrentUser();
    const recs = recommendLearningContent(me, 4);
    if (!recs.length) {
      panel.innerHTML = `<p class="empty-state">Set a learning goal on your profile (what you want to learn) and we'll suggest a course and video here, matched to it.</p>`;
    } else {
      panel.innerHTML = `
        <p class="muted small">Matched to what you said you want to learn: ${(me.learningGoals || []).join(", ")}. All picks are in English.</p>
        ${recs.map(learningContentHTML).join("")}`;
    }
  } else if (key === "faqs") {
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
/* Ask Click: rule-based assistant                                    */
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
  kb.push({ a: "Go to My Journey and use “Schedule a conversation” to create a calendar invite (.ics, Google, or Outlook) with reminders.", primary: "schedule a conversation or meeting", secondary: "calendar invite booking reminders" });
  kb.push({ a: "From My Journey, use “End connection (rematch).” It's no-fault, no explanation required. A Super Admin can also end a connection on someone's behalf from the Admin console.", primary: "end a connection or request a rematch", secondary: "stop pause quit leave the relationship" });
  kb.push({ a: "Open your avatar menu in the top right and choose “My profile” to update what you're learning, offering, your availability, or your capacity.", primary: "edit or update my profile, hours, or frequency", secondary: "change settings capacity availability" });
  kb.push({ a: "Open Learning Resources and check the “Recommended for you” tab — it matches a LinkedIn Learning course, and sometimes a YouTube video, to what you said you want to learn on your profile. Set a learning goal there first if nothing shows up.", primary: "find a course or video for what I'm learning", secondary: "linkedin learning youtube recommended course video training" });
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

  // A Super Admin's proxy session overrides which account is "current",
  // without touching activeDemoUser, so the admin's own login survives it.
  if (PROXY) {
    if (getEmployeeById(PROXY.targetId)) {
      CURRENT_USER_ID = PROXY.targetId;
    } else {
      PROXY = null;
      persistProxySession();
    }
  }
}

/** A brand-new account (like the newuser1 demo persona) has no name yet, so
 * fall back to its login username rather than showing a blank in the banner/log. */
function proxyLabel(emp) {
  if (!emp) return "this account";
  if (emp.displayName) return emp.displayName;
  if (emp.fullName) return emp.fullName;
  const account = DEMO_ACCOUNTS.find((a) => a.id === emp.id);
  return account ? `${account.username} (no profile yet)` : "this account";
}

/** Lets a Super Admin see (and act in) the app exactly as another account
 * would, for troubleshooting or finishing a stuck task on someone's behalf.
 * The original admin identity is remembered so "Exit proxy" can restore it. */
function startProxy(targetId) {
  const anchorAdminId = PROXY ? PROXY.adminId : CURRENT_USER_ID;
  const admin = getEmployeeById(anchorAdminId);
  const target = getEmployeeById(targetId);
  if (!admin || !isSuperAdminUser(admin) || !target || targetId === anchorAdminId) return;
  PROXY = { adminId: anchorAdminId, targetId };
  persistProxySession();
  CURRENT_USER_ID = targetId;
  logAdminAction(`Started viewing the app as ${proxyLabel(target)}.`, anchorAdminId);
  toast(`Viewing as ${proxyLabel(target)}.`, "success");
  renderUserChrome();
  switchTab("home");
  renderHome();
}

function exitProxy() {
  if (!PROXY) return;
  const admin = getEmployeeById(PROXY.adminId);
  const target = getEmployeeById(PROXY.targetId);
  if (admin && target) logAdminAction(`Stopped viewing the app as ${proxyLabel(target)}.`, admin.id);
  CURRENT_USER_ID = PROXY.adminId;
  PROXY = null;
  persistProxySession();
  toast("Exited proxy view.");
  renderUserChrome();
  switchTab("admin");
  renderHome();
}

function renderProxyBanner() {
  const banner = $("#proxy-banner");
  const exitBtn = $("#exit-proxy-btn");
  if (PROXY) {
    const admin = getEmployeeById(PROXY.adminId);
    const target = getEmployeeById(PROXY.targetId);
    $("#proxy-banner-text").textContent = `Viewing as ${proxyLabel(target)} — proxied by ${proxyLabel(admin)}. Actions you take here are attributed to them.`;
    banner.classList.remove("hidden");
    exitBtn.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
    exitBtn.classList.add("hidden");
  }
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
        { id: "s2", stage: "goal", date: "2026-07-21", notes: "Set “present forecasts to leadership” as the goal.", completed: true },
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

  $("#role-tutorial-next").addEventListener("click", () => {
    const data = ROLE_TUTORIALS[roleTutorialRole];
    if (roleTutorialStepIndex >= data.points.length - 1) {
      closeAllModals();
      if (roleTutorialRole === "mentor") openBecomeMentorRoleModal();
      else openBecomeMenteeRoleModal();
      return;
    }
    roleTutorialStepIndex++;
    renderRoleTutorialStep();
  });
  $("#role-tutorial-back").addEventListener("click", () => {
    if (roleTutorialStepIndex === 0) return;
    roleTutorialStepIndex--;
    renderRoleTutorialStep();
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
        if (isAdminUser(getCurrentUser())) openSettingsModal();
        break;
      case "view-profile":
        $("#user-menu").classList.add("hidden");
        openProfileModal({ onboarding: false });
        break;
      case "sign-out":
        $("#user-menu").classList.add("hidden");
        localStorage.removeItem(STORAGE.activeDemoUser);
        PROXY = null;
        persistProxySession();
        CURRENT_USER_ID = null;
        showLoginScreen();
        break;
      case "reset-demo-data":
        $("#user-menu").classList.add("hidden");
        openConfirmModal(
          {
            title: "Reset demo data?",
            body: "This clears every connection, journey, nudge, and status change made in this browser and brings the demo accounts back to their starting state. You'll be signed out. This can't be undone.",
            confirmLabel: "Reset demo data",
            danger: true,
          },
          resetDemoData
        );
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
      case "nudge-adoption": {
        const incomplete = getIncompleteProfiles();
        sendBulkNudge(
          incomplete,
          "Finish setting up your Click profile",
          "Hi,\n\nA quick nudge to finish setting up your Click profile; it only takes a few minutes and it's what powers your matches.\n\nThanks,\nPeople Development"
        );
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
        confirmRematch(el.dataset.id);
        break;
      case "confirm-yes": {
        const action = pendingConfirmAction;
        pendingConfirmAction = null;
        closeAllModals();
        if (action) action();
        break;
      }
      case "proxy-user":
        startProxy(el.dataset.id);
        break;
      case "exit-proxy":
        exitProxy();
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
  ["#roster-filter-department", "#roster-filter-geo", "#roster-filter-format", "#roster-filter-status"].forEach((sel) =>
    $(sel).addEventListener("change", renderRoster)
  );

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
      deliveryFormat: fd.get("deliveryFormat"),
      preferredLanguage: fd.get("preferredLanguage"),
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
      deliveryFormat: fd.get("deliveryFormat"),
      preferredLanguage: fd.get("preferredLanguage"),
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
      deliveryFormat: fd.get("deliveryFormat"),
      preferredLanguage: fd.get("preferredLanguage"),
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
    const title = `Click: ${stage ? stage.label : stageKey} conversation`;
    const description = `${stage ? stage.detail : ""}\n\nScheduled from Click: ${journey.relationshipType}.`;
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
      filename: `click-${stageKey}-conversation.ics`,
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
    toast("Pulse check submitted.", "success");
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
  restoreProxySession();
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
  PROXY = null;
  persistProxySession();
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
