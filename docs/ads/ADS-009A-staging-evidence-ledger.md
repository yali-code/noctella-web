# ADS-009A — Staging Acceptance Evidence Ledger (template)

**Status: TEMPLATE ONLY — NOT EXECUTED OR APPROVED.** This document is an operational evidence register to accompany `ADS-009-staging-acceptance-checklist.md` (currently Draft PR #347). It grants no staging access, provider read, data write, deployment, campaign execution, spend or database schema permission.

Tracking issue: #335. Scope: Noctella Ads Agent Phases 6–9, **staging only**, EUR-only. Existing production SQLite `/var/data/noctella.sqlite` and R2 backup buckets are explicitly out of scope.

> **Current operational checkpoint (12 October 2026):** See the evidence supplement below before using the original blank template. The original matrix is retained as an acceptance *template*, not an assertion that already-verified E01–E03 work is missing. No approval is granted by this documentation change.

## 2026-10-12 E08 live staging HTTP and UI evidence supplement

**Disposition: HTTP authorization/no-mutation acceptance PASS (operator-attested), E04 overall acceptance PENDING.** This section supersedes the earlier E08 `NOT RUN` snapshot in the historical template below. It does not authorize paid-provider reads, ad spend, production activation or a staging paid-data collection write.

- **Reviewed and deployed SHA:** `5c921c807648058dab104ab2f56853037776aeca`; main CI [38221345941](https://github.com/yali-code/noctella-web/actions/runs/38221345941) SUCCESS; staging API `dep-db69ejp5efls73bcft80`, Admin `dep-db69ek15efls73bcftvg`, Storefront `dep-db69ek15efls73bcfu40` LIVE at that SHA.
- **Without a session:** all four analytics paid Ads GET endpoints returned **401 (4/4)** from owner-run Render staging Shell; [evidence](https://github.com/yali-code/noctella-web/issues/335#issuecomment-6120524182).
- **Insufficient privilege:** an isolated staging Product Editor session was verified by `GET /api/auth/me` (**200**, role `product_editor`), then all four Ads GETs returned **403 (4/4)**; [evidence](https://github.com/yali-code/noctella-web/issues/335#issuecomment-6121125291). The temporary account was subsequently **disabled**, with **zero sessions** remaining by owner-run Shell output; [cleanup evidence](https://github.com/yali-code/noctella-web/issues/335#issuecomment-6121202577).
- **Authorized read and caching:** existing Owner session authenticated as `owner` (`/api/auth/me` **200**); readiness, paid performance, intelligence and campaign draft GETs returned **200** and `Cache-Control: no-store` (**4/4**); [consolidated owner log](https://github.com/yali-code/noctella-web/issues/335#issuecomment-6121380415).
- **Mutation methods:** POST/PUT/PATCH/DELETE returned **404** on readiness (**4/4**) and on performance, intelligence and campaign draft (**12/12**), altogether **16/16**; [readiness evidence](https://github.com/yali-code/noctella-web/issues/335#issuecomment-6120907567), [consolidated evidence](https://github.com/yali-code/noctella-web/issues/335#issuecomment-6121380415). No write endpoints or ad actions were invoked.
- **Owner-facing Marketing UI:** paid publishing and spend show `DISABLED`; Meta configuration `CONFIG REVIEW REQUIRED` with `connectionVerified: NO`, Google/Pinterest `NOT CONFIGURED`; performance `NOT_COLLECTED`, intelligence avoids zero for missing windows and does not compute marketplace ROAS without verified attribution. Campaign draft resolved an existing staging ERP product and four photos but returned **no eligible marketplace listing**, so **no executable or eligible draft was generated**. [UI evidence](https://github.com/yali-code/noctella-web/issues/335#issuecomment-6120720816).
- **Boundary:** these results are operator-provided HTTP status/header and UI observations, not an independent credential or payload capture. A full eligible-marketplace creative draft was not exercised; secret non-echo remains covered by synthetic tests rather than a live sensitive-response audit. Do not infer E05 Meta ad account verification, E06 real windows, E07 snapshot writes, E09 billing reconciliation, E10 provider scope, E11 attribution or E12 disaster-recovery exercise.

**No provider credentials, cookies, passwords, session tokens, production data, authorized spending or paid-provider queries were used in this E08 acceptance work.**

## 2026-10-12 E04 read-only evidence supplement

This supplement is the current observed checkpoint for GitHub issue [#335](https://github.com/yali-code/noctella-web/issues/335). It does **not** overwrite historical notes or expand the owner's authorization.

| Gate / aspect | Verified observation | Limitation / disposition |
|---|---|---|
| E01 — engineering CI and deploy convergence | GitHub `main` SHA `8f2d929884efd26be75241e8f67feb64bab1daac`; GitHub Actions CI run [38162375527](https://github.com/yali-code/noctella-web/actions/runs/38162375527) succeeded. Render staging API `dep-db5ulrqjnfac73bprbh0`, Admin `dep-db5t4jn40ujc73cr1ujg`, Storefront `dep-db5t4jn40ujc73cr1ung` all LIVE on that SHA. | **PASS for CI/deployment convergence only**; independent E04 functional/security acceptance is separate. |
| E02 — isolation and R2 targets | Staging API disk `dsk-d9lnbgf10e5c73e1qp1g` mounted at `/var/data`, different from operator-reported production disk `dsk-db34390m7kps73cv8mh0`. Staging API origins and S3 token scopes, dedicated staging buckets, scheduled backup artifacts and cron results attested in issue #335. | **OPERATOR PASS**, not independently inspected Cloudflare API privileges or a separate security-review signoff. |
| E03 — integrity verification | In the staging API shell, a temporary read-only SQLite backup download passed integrity and SHA-256 validation (2,514,944 bytes; SHA-256 `18ab73d08772ce5218a9ccfdbafd478088ce34df6f3a940ec6ece84d44c1ebb1`). Staging photo manifest verifier reported `verifiedArtifacts: 52`, `integrity: ok`. See [E03 evidence](https://github.com/yali-code/noctella-web/issues/335#issuecomment-6119407647). | **PASS for nondestructive integrity verification only**; no actual service swap, backup materialization to live location, or disaster-recovery cutover rehearsal occurred. Do not treat E12 as done. |
| E04 — owner staging acceptance authorization | Named staging services and reviewed SHA are documented. Read-only audit recorded at [#335 E04 checkpoint](https://github.com/yali-code/noctella-web/issues/335#issuecomment-6119455339). | **PENDING** explicit scoped owner approval/signoff under the acceptance policy. Existing deployments are not authorization for new operations. |
| E08 — Admin HTTP authorization | Code-tested CI plus separately operator-attested live staging checks on the same reviewed SHA; see 12 October E08 supplement above. | **LIVE HTTP AUTHORIZATION CHECKS PASS (operator-attested)**. Eligible-listing draft, independent sensitive-response audit and operational E04 signoff remain separate. |
| E05–E07 / E09–E12 — provider and operational acceptance | No newly authorized real paid-provider collection, staging SQLite write, finalized billing reconciliation, provider scoping decision, purchase attribution or rollback cutover in this checkpoint. | **BLOCKED / NOT RUN** according to the original matrix. Never claim real spend or attribution from fixtures. |

### Scoped next actions

1. Perform a non-mutating staging E08 unauthenticated HTTP smoke with sanitized results, then independently verify 403 and 200 only through an authorized operator session without exposing credentials or session cookies.
2. Capture explicit owner E04 approval with exact reviewed commit and service IDs before any new operationally consequential action. A deployed commit does not itself authorize paid-provider reads or writes.
3. Keep E05 provider access, E07 storage writes, and E12 live restore rehearsal separately authorized. Do not change production, campaign state, budgets, or provider tokens.
4. Preserve EUR, provider-local reporting periods, and UNKNOWN for missing data. Confirm Google/Pinterest separately or record an explicit owner de-scope.

## Owner and reviewer decision

| Field | Value to record |
|---|---|
| Staging deploy authorization | **NOT GRANTED** — link to explicit owner approval only if provided |
| Staging snapshot-write authorization | **NOT GRANTED** — must be separate from read-only approval |
| Production changes or campaign spend | **PROHIBITED** |
| Evidence owner / reviewer | TBD / TBD |
| Integrated commit SHA and PR review links | TBD |
| Staging service identifiers | TBD, verify actual environment and isolation |
| Date/time of acceptance execution (Europe/Sofia and UTC) | NOT EXECUTED |
| Final disposition | **BLOCKED** until every required gate has independent evidence |

Never put tokens, passwords, OAuth headers, raw vendor payloads, full billing documents, personal buyer details or private backup URLs into this repository or issue comments. Store sensitive evidence in an owner-controlled private location; reference it by a non-secret stable locator and a checksum only when appropriate.

## Evidence matrix

Record **PASS**, **FAIL**, **BLOCKED** or **NOT RUN**. PASS requires the specified observed evidence and a reviewer; a test or proposed plan by itself is never a PASS.

| Gate | Status | Required observable proof (redacted) | Owner/reviewer and evidence reference |
|---|---|---|---|
| E01: reviewed engineering composition | NOT RUN | Exact branch SHA; completed GitHub CI run with typecheck, tests, build, lint; independent review of outstanding security findings | TBD |
| E02: staging/prod isolation | PARTIAL (source review only; runtime NOT RUN) | Staging API/Admin service IDs; staging **service and disk IDs** distinct from production (an identical in-volume DB path is acceptable); no prod R2 target; sanitized environment name comparison. Source review and attestation procedure: `ADS-009C-staging-isolation-review.md` | ADS-009C (source); runtime auditor `npm run ops:isolation-audit` (ADS-009D), operator run TBD |
| E03: staging backup and restore | NOT RUN | Pre-deploy staging-only backup checksum, timestamp and a restore rehearsal to a disposable isolated DB; no credentials in record. Prerequisites: `ADS-009C` §5 (separately authorized; not executed) | TBD |
| E04: owner staging deploy consent | BLOCKED | Explicit scoped approval for reviewed SHA, named staging services, no prod or campaign changes | TBD |
| E05: Meta read-only account verification | BLOCKED | Verified account ID (consider masked display), EUR, ads_read, non-empty IANA reportingTimeZone, sanitized result status; no raw token | TBD |
| E06: completed paid reporting window | BLOCKED | Actual account/campaign identity, local inclusive dates, IANA zone, derived UTC half-open timestamps, completion as of observation time; no empty result mislabelled zero | TBD |
| E07: storage command and owner write consent | BLOCKED | Separate staging-only write tool approval, allowlisted staging DB, explicit one-shot acknowledgement, backup, observed write/replay/restatement checks | TBD |
| E08: Admin permission and no-mutation smoke | NOT RUN | 401 unauthenticated, 403 insufficient scope, 200 authorized read, no-store, 404 mutation verbs, no secret echoes, no execute/approve affordance | TBD |
| E09: reconciliation to finalized billing | BLOCKED | Independent *finalized* bill mapped to same provider, account, campaign, account-local dates and EUR amount; tax/fees excluded; discrepancy calculation and status | TBD |
| E10: other paid providers | BLOCKED | Google/Pinterest equivalent evidence or explicit owner de-scoping for current acceptance | TBD |
| E11: attribution/ROAS | BLOCKED | Verified deduplicated marketplace sale linkage **only if claiming attribution**; otherwise ROAS remains UNKNOWN/null | TBD |
| E12: rollback rehearsal | NOT RUN | Revert plan, staging-only restore and token deactivation/remove process; no production modification | TBD |

## Billing reconciliation worksheet (evidence, not data ingestion)

Use one worksheet per **provider + account + campaign + account-local completed interval**. A provider reporting summary is **not** a billing statement.

| Field | Value |
|---|---|
| Provider / currency | TBD / EUR |
| Advertising account ID (redact in public issue if needed) | TBD |
| Campaign ID | TBD |
| Verified account IANA time zone | TBD |
| Local start date (inclusive) / local end date (inclusive) | TBD / TBD |
| UTC window start (inclusive) / UTC window end (exclusive) | TBD / TBD |
| Provider snapshot run ID / source reference | TBD / TBD |
| Stored paid spend (EUR cents) | UNKNOWN |
| Billing statement finalized date / private evidence reference | UNKNOWN / TBD |
| Billed **ad spend only** (EUR cents) | UNKNOWN |
| VAT, platform fees, adjustments (excluded; list separately) | UNKNOWN |
| Difference: abs(stored spend - billed ad spend) (EUR cents) | UNKNOWN |
| Scope match: provider/account/campaign/window/currency | NOT VERIFIED |
| Reconciliation policy result | **NOT ASSESSED** |
| Human sign-off / date | TBD |

Guidance: calculate all monetary differences in **integer EUR cents** where possible. Do not change unknown to zero. A difference within €0.01 is relevant **only if** finalized billing evidence and exact scope match are established; do not label reporting-only spend reconciled. Replays and provider restatements must be separately reported, not silently overwritten.

## Operational incident record / rollback trigger

If the wrong account, wrong currency, wrong reporting zone, incomplete window, mismatched billing scope, provider credential exposure, unexpected schema migration, production DB target or any provider mutation is observed:

1. Stop the **staging** test immediately; do not retry against production.
2. Mark affected gate **FAIL** with sanitized facts; do not claim readiness.
3. Obtain owner direction before deleting data, rotating/revoking credentials or changing deployments.
4. Preserve sanitized diagnostics and capture the prior staging backup reference.
5. Re-test after a reviewed fix and new approval; prior PASS entries are not transferable to a changed SHA.

## Sign-off

- Engineering evidence reviewed by: **PENDING**
- Provider/billing evidence reviewed by: **PENDING**
- Owner staging acceptance: **NOT GRANTED**
- Production release approval: **NOT GRANTED**
- Paid campaign execution and spend approval: **NOT GRANTED**

No signature or checkbox in this template authorizes an operation; explicit out-of-band owner approval is still required.
