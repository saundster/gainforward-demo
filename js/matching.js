/* GainForward — matching engine.
   Implements the weighted scoring rubric from SOP Section 17 (Matching
   Architecture) so the Directory and Admin > Matching Queue views can show
   a real, explainable score instead of a random number. */

const FORMAT_COMPATIBILITY = {
  mentee: ["mentor"],
  mentor: ["mentee"],
  peer: ["peer"],
  reverse: ["reverse"],
};

function normalizeText(value) {
  return (value || "").toLowerCase().trim();
}

function keywordOverlapScore(listA, listB) {
  if (!listA?.length || !listB?.length) return 0;
  const a = listA.map(normalizeText);
  const b = listB.map(normalizeText);
  let hits = 0;
  a.forEach((goal) => {
    const goalWords = goal.split(/\s+/).filter((w) => w.length > 3);
    const matched = b.some((skill) => {
      if (skill.includes(goal) || goal.includes(skill)) return true;
      return goalWords.some((w) => skill.includes(w));
    });
    if (matched) hits += 1;
  });
  return Math.min(1, hits / a.length);
}

function complementScore(seeker, candidate) {
  let score = 0.5;
  if (seeker.department !== candidate.department) score += 0.3;
  if (seeker.geography !== candidate.geography) score += 0.1;
  if (seeker.careerLevel !== candidate.careerLevel) score += 0.1;
  return Math.min(1, score);
}

function formatScore(seeker, candidate) {
  const compatible = FORMAT_COMPATIBILITY[seeker.preferredFormat] || [];
  return compatible.includes(candidate.preferredFormat) ? 1 : 0.35;
}

function availabilityScore(seeker, candidate) {
  if (!seeker.availability || !candidate.availability) return 0.5;
  let score = 0;
  if (seeker.availability.frequency === candidate.availability.frequency) score += 0.5;
  const seekerZone = normalizeText(seeker.availability.timezone).split(" ")[0];
  const candidateZone = normalizeText(candidate.availability.timezone).split(" ")[0];
  if (seekerZone === candidateZone) score += 0.5;
  else score += 0.2;
  return Math.min(1, score);
}

function otherPreferenceScore(seeker, candidate) {
  const note = normalizeText(seeker.matchNote);
  if (!note) return 0.7;
  if (note.includes("outside my function") && seeker.department !== candidate.department) return 1;
  if (note.includes("another") && note.includes(normalizeText(candidate.department))) return 1;
  return 0.6;
}

/** Returns { total (0-100), breakdown: [{key,label,weight,score}] } */
function computeMatchScore(seeker, candidate) {
  const weights = PROGRAM_META.matchWeights;
  const rawScores = {
    goal: keywordOverlapScore(seeker.learningGoals, candidate.offeredSkills),
    complement: complementScore(seeker, candidate),
    format: formatScore(seeker, candidate),
    availability: availabilityScore(seeker, candidate),
    other: otherPreferenceScore(seeker, candidate),
  };

  let total = 0;
  const breakdown = weights.map((w) => {
    const score = rawScores[w.key] ?? 0;
    total += score * w.weight;
    return { ...w, score };
  });

  return { total: Math.round(total * 100), breakdown };
}

function matchQualityAnswerDefaults(seeker, candidate) {
  // Pre-fills the objective checklist items PD can verify programmatically;
  // subjective items (e.g. "explain in one sentence why they should meet")
  // are always left for a human reviewer to confirm.
  return PROGRAM_META.matchChecklist.map((question, index) => {
    if (question.toLowerCase().includes("conflict of interest")) {
      return { question, checked: seeker.department !== candidate.department, autofilled: true };
    }
    if (question.toLowerCase().includes("format")) {
      return { question, checked: formatScore(seeker, candidate) === 1, autofilled: true };
    }
    return { question, checked: false, autofilled: false };
  });
}
