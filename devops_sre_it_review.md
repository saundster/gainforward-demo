# Ripple — DevOps / SRE / IT Readiness Review

**Scope:** this is a genuinely static, backend-free prototype (no server, no database, no build step) deployed to Vercel from this GitHub repo. Everything below is checked against the actual repo and live deployment, not assumed. The bottom line up front:

**As a demo/prototype for a trusted group of testers, it's in good shape.** **As something a real employee population would use with real data, it would fail nearly every standard DevOps/SRE/IT gate** — not because it was built carelessly, but because those gates assume a backend, and this deliberately has none yet. That's the one thing to walk into the conversation with your DevOps/IT/SRE team already knowing.

---

## DevOps

| Item | Status | Notes |
|---|---|---|
| Source control | ✅ Pass | Git, GitHub-hosted, descriptive commit history, no force-pushes. |
| CI pipeline (build/lint/test gate) | ❌ Fail | None exists. No `.github/workflows`, no test suite, no lint step. Every push to `master` goes straight to Vercel with zero automated checks. |
| Environment separation (dev/staging/prod) | ❌ Fail | One environment. No staging slot, no preview-then-promote flow in use — pushing to `master` *is* the production deploy. |
| Rollback plan | ⚠️ Partial | Git history + Vercel's own deployment history both exist, so a manual revert/re-promote is possible, but there's no documented runbook and no automated rollback trigger. |
| Infrastructure as code | N/A | Nothing to declare — static hosting only, Vercel zero-config. |
| Dependency management | ⚠️ Partial | Two runtime dependencies (SheetJS/xlsx, html2canvas), both version-pinned in the `<script src>` URL — good. No `package.json`/lockfile (there's no npm install step at all), no automated dependency-vulnerability scanning (e.g. Dependabot), no Subresource Integrity hash on either CDN `<script>` tag. |
| Secrets management | ✅ Pass (trivially) | Scanned the full source for API keys/tokens/credentials — none exist, because the app makes zero authenticated external calls. Nothing to leak. |

## SRE

| Item | Status | Notes |
|---|---|---|
| Uptime monitoring / alerting | ❌ Fail | None. Relies entirely on Vercel's own platform SLA; no synthetic checks, no on-call, no status page. |
| Observability (logs/metrics/error tracking) | ❌ Fail | No error tracking (no Sentry or equivalent), no analytics, no structured logging anywhere. A runtime error is visible only in the browser console of whoever happens to be looking. |
| Incident response process | ❌ Fail | No runbook, no defined severity levels, no on-call rotation — appropriate for a prototype, not for anything with real users depending on it. |
| Backup / disaster recovery | ❌ Fail (structural) | This is the one that matters most for a real rollout: **every real user's actual data — conversations, goals, reflections, everything — would live only in that one browser's `localStorage`.** No server-side copy exists anywhere. Clear site data, switch devices, or lose the browser profile, and it's gone. There is nothing to back up because there's no database. |
| Scalability | N/A / by design | Static assets scale trivially via Vercel's CDN. But "scale" doesn't really apply to the data layer, because there functionally isn't one shared between users — every browser is its own siloed instance. |

## IT / Security / Compliance

| Item | Status | Notes |
|---|---|---|
| Authentication | ❌ Fail (by explicit design) | Login is a client-side username/password check against a hardcoded list, visible to anyone who opens dev tools — the code's own header comment says as much: *"NOT real secured accounts... visible to anyone who opens dev tools."* The `HRIS/SSO integration` text in the data is narrative flavor for one persona, not a real integration. |
| Authorization | ❌ Fail (by explicit design) | Admin/Super Admin gating is a client-side field check, trivially bypassable in dev tools. Fine for a small trusted-tester group; not IT-compliant for real use. |
| Data privacy / PII | ⚠️ N/A today, real gap tomorrow | Current data is entirely fabricated demo personas — no real PII exists. But the *architecture* stores whatever it holds in plaintext, unencrypted `localStorage`, with no consent flow, no retention policy, and no way to honor a real data-deletion request. If real employee data were ever pointed at this exact codebase unchanged, it would fail basic data-privacy expectations immediately. |
| Transport security (HTTPS) | ✅ Pass | Served over HTTPS by default via Vercel. |
| Security headers / CSP | ❌ Fail | No `Content-Security-Policy`, no other security headers configured (no `vercel.json`, no meta CSP tag). |
| Supply-chain / subresource integrity | ⚠️ Partial | Both CDN scripts are pinned to an exact version, which is good practice — but neither has a Subresource Integrity (`integrity=`) hash, so there's no cryptographic guarantee against the CDN serving something other than what was reviewed. |
| Accessibility | ⚠️ Partial, better than average | Modals correctly use `role="dialog"` + `aria-modal`, tabs use proper `role="tab"`/`tablist`, toasts use `aria-live`. No `<img>` tags at all (everything is inline SVG, so no missing alt-text problem). Not run through a formal audit (axe/Lighthouse), so treat this as "reasonable baseline," not "certified compliant." |
| Licensing / content use | ⚠️ Worth a light legal check | Learning-resource recommendations reference real LinkedIn Learning course titles/instructors and a real YouTube channel. The README already flags this ("confirm access in your own org's catalog"), which is the right instinct — just make sure whoever owns content/legal sign-off has actually seen that list before this goes beyond a demo. |

---

## What's already genuinely good

- No secrets, no credentials, no leaked keys anywhere in source — verified by scanning the full codebase, not assumed.
- Dependencies are minimal (two libraries total) and version-pinned.
- The README already documents, in its own words, exactly which calendar features are real vs. which need a backend — that's the right instinct, and it's rare to see a prototype be this honest about its own limitations in its own docs.
- Reasonable accessibility semantics without anyone having asked for them yet.
- Nothing here is secretly worse than it looks — the gaps above are all things the project's own comments already admit to, not things I had to dig to find.

## If/when this goes toward a real rollout — priority order

1. **A real backend + database.** Everything else is downstream of this. No auth, no persistence, no shared state across devices, and no backup story exist until there's a server holding the data instead of each browser's `localStorage`.
2. **Real SSO** (the thing already being worked with your DevOps/IT team for calendar) needs to also cover login itself, replacing the client-side password check.
3. **Basic observability** — even just an error-tracking hook (Sentry-style) before real users touch it, so a broken flow doesn't go unnoticed.
4. **CI gate** — even a minimal one (lint + a smoke test) before every deploy, since right now nothing stops a bad push from going straight to the live URL.
5. **Security headers + SRI** on the two CDN scripts — cheap, fast, no architecture change required.
6. **A documented rollback runbook** — the mechanics already exist (git + Vercel history), it just isn't written down anywhere.

None of the above is needed to keep using this as a demo/prototype with trusted testers, which is exactly what it's been built for. It becomes a real checklist the moment real employee data or a broader employee population is on the table.
