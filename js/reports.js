/* GainForward — stakeholder reports.
   Everything here runs client-side, in the browser that clicks the button —
   there's no server rendering the file. Excel export uses SheetJS, PNG
   export uses html2canvas (both loaded via CDN in index.html), and PDF
   export reuses the browser's own "Print to PDF" — no extra library needed,
   and it produces a properly paginated PDF in every modern browser. */

function reportDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function buildKpiRows() {
  const groups = [
    ["Adoption", PROGRAM_META.kpis.adoption],
    ["Relationship quality", PROGRAM_META.kpis.relationshipQuality],
    ["Learning impact", PROGRAM_META.kpis.learningImpact],
  ];
  const rows = [];
  groups.forEach(([groupLabel, metrics]) => {
    metrics.forEach((m) => {
      const value = kpiValue(m.key);
      let display;
      if (value === null) display = "No data yet";
      else if (m.format === "percent") display = pct(value);
      else if (m.format === "score") display = `${value.toFixed(1)} / 5`;
      else display = Math.round(value);
      const targetDisplay = m.target === null || m.target === undefined ? "—" : m.format === "percent" ? pct(m.target) : m.format === "score" ? m.target.toFixed(1) : m.target;
      rows.push({ Category: groupLabel, Metric: m.label, Value: display, Target: targetDisplay });
    });
  });
  return rows;
}

function buildCohortRows(keyFn) {
  const counts = {};
  employees.forEach((e) => {
    const key = keyFn(e) || "—";
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ Group: label, Participants: count }));
}

function buildRosterRows() {
  return employees.map((e) => ({
    Name: e.displayName || e.fullName || "—",
    Department: e.department || "—",
    Region: e.geography || "—",
    Format: formatLabel(e.preferredFormat),
    Status: statusLabel(e.engagementStatus),
    Rating: e.rating ?? "—",
    Mentees: e.menteeCount ?? 0,
  }));
}

function buildRequestRows() {
  return requests.map((r) => {
    const from = getEmployeeById(r.fromId);
    const to = getEmployeeById(r.toId);
    return {
      From: from ? from.displayName : r.fromId,
      To: to ? to.displayName : r.toId,
      "Score (%)": r.score,
      Status: r.status,
      "Created at": r.createdAt ? r.createdAt.slice(0, 10) : "—",
    };
  });
}

function exportExcelReport() {
  const statusEl = $("#export-status");
  if (typeof XLSX === "undefined") {
    statusEl.textContent = "Excel export library didn't load — check your connection and try again.";
    return;
  }
  try {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildKpiRows()), "KPIs");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildCohortRows((e) => e.department)), "Cohort by dept");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildCohortRows((e) => e.geography)), "Cohort by region");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildRosterRows()), "Roster");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(buildRequestRows()), "Requests");
    XLSX.writeFile(wb, `GainForward-Report-${reportDateStamp()}.xlsx`);
    statusEl.textContent = "";
    toast("Excel report downloaded.", "success");
  } catch (err) {
    statusEl.textContent = `Excel export failed: ${err.message}`;
  }
}

function buildPrintReportHTML() {
  const kpiRows = buildKpiRows();
  const deptRows = buildCohortRows((e) => e.department);
  const geoRows = buildCohortRows((e) => e.geography);

  const table = (headers, rows) => `
    <table class="print-table">
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${headers.map((h) => `<td>${r[h]}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>`;

  return `
    <h1>GainForward — Program Report</h1>
    <p class="print-meta">Generated ${new Date().toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })}</p>
    <h2>Program scorecard</h2>
    ${table(["Category", "Metric", "Value", "Target"], kpiRows)}
    <h2>Cohort by department</h2>
    ${table(["Group", "Participants"], deptRows)}
    <h2>Cohort by region</h2>
    ${table(["Group", "Participants"], geoRows)}
    <p class="print-footer">GainForward · RateGain Mentorship &amp; Peer Learning Ecosystem</p>`;
}

function exportPDFReport() {
  $("#print-report").innerHTML = buildPrintReportHTML();
  document.body.classList.add("printing-report");
  const cleanup = () => document.body.classList.remove("printing-report");
  window.addEventListener("afterprint", cleanup, { once: true });
  setTimeout(() => window.print(), 50);
}

function exportPNGReport() {
  const statusEl = $("#export-status");
  if (typeof html2canvas === "undefined") {
    statusEl.textContent = "PNG export library didn't load — check your connection and try again.";
    return;
  }
  statusEl.textContent = "Rendering snapshot…";
  html2canvas(document.getElementById("insights-report-area"), { backgroundColor: "#ffffff", scale: 2 })
    .then((canvas) => {
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `GainForward-Insights-${reportDateStamp()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        statusEl.textContent = "";
        toast("Snapshot downloaded.", "success");
      });
    })
    .catch((err) => {
      statusEl.textContent = `Snapshot failed: ${err.message}`;
    });
}
