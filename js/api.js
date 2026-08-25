/* GainForward — pluggable employee-data source.
   The prototype ships with the mock roster in js/data.js. Once you have an
   API key for pulling real employee details, configure it from the header's
   "Data source" button — no code changes needed for a standard REST/JSON
   endpoint. See README.md for the exact request/response contract.

   SECURITY NOTE (prototype only): the key is kept in this browser's
   localStorage purely so the demo can round-trip a live call. Do not ship
   a production build that puts real API keys in client-side code — proxy
   the call through a backend before this goes beyond a prototype. */

const AI_CONFIG_KEY = "gainforward.aiConfig";

function getAIConfig() {
  try {
    const raw = localStorage.getItem(AI_CONFIG_KEY);
    return raw ? JSON.parse(raw) : { provider: "custom", endpoint: "", apiKey: "", enabled: false };
  } catch {
    return { provider: "custom", endpoint: "", apiKey: "", enabled: false };
  }
}

function saveAIConfig(config) {
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
}

function clearAIConfig() {
  localStorage.removeItem(AI_CONFIG_KEY);
}

/**
 * Expected response shape from `config.endpoint`:
 *   { "employees": [ { id, fullName, displayName, department, division,
 *       careerLevel, tenureBand, geography, learningGoals, offeredSkills,
 *       preferredFormat, aiConfidence, availability, engagementStatus,
 *       rating, menteeCount, ... } ] }
 * Field names should match js/data.js so the rest of the app needs no changes.
 */
async function fetchEmployeesFromAI(config) {
  if (!config.endpoint || !config.apiKey) {
    throw new Error("Endpoint and API key are both required.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(config.endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Request failed: ${res.status} ${res.statusText}`);
    }
    const payload = await res.json();
    if (!Array.isArray(payload.employees)) {
      throw new Error("Response did not include an `employees` array.");
    }
    return payload.employees;
  } finally {
    clearTimeout(timeout);
  }
}

/** Loads the working directory: live data if configured + enabled, else the seed. */
async function loadEmployeeDirectory() {
  const config = getAIConfig();
  if (config.enabled && config.endpoint && config.apiKey) {
    try {
      const employees = await fetchEmployeesFromAI(config);
      return { employees, source: "ai" };
    } catch (err) {
      console.warn("AI data source failed, falling back to seed data:", err.message);
      return { employees: SEED_EMPLOYEES, source: "seed-fallback", error: err.message };
    }
  }
  return { employees: SEED_EMPLOYEES, source: "seed" };
}
