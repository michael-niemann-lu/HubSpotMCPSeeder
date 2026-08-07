# CLAUDE.md — Demo Data Seeder (Google Apps Script + Sheets)

> Supersedes any earlier Python-based version of this brief. Same safety model, different runtime.

## What we're building

A Google Sheets workbook plus container-bound Apps Script that seeds, refreshes, and safely removes demo data across two platforms, so an AI assistant querying both via MCP can answer cross-system questions about training and support data.

- **LearnUpon** (ACME demo portal) — users, groups, courses, enrollments, backdated completions
- **HubSpot** (demo portal) — companies, contacts, support tickets, deals

The Sheet is the authoring surface: three sales engineers declare *intent* ("Fernpath filed 14 Integrations tickets before the course, 2 after"), and the script expands declarations into concrete records with deterministic dates.

Three demo scenarios share one set of accounts and people:
1. Customer onboarding health
2. Knowledge gaps vs. support tickets
3. Upsell and renewal readiness

---

## Non-negotiable safety requirements

**Both platforms contain data belonging to other people. This toolkit must never delete, modify, or archive a record it did not create.** Read this section fully before writing code.

### Layer 1 — The `_Manifest` tab is the only authority for deletion

Every record created is appended to `_Manifest` with its platform ID. Reset reads *only* from the manifest. It must never discover records to delete by searching, filtering, or querying either platform. If a record isn't in the manifest, it doesn't get touched — even if it looks like ours.

### Layer 2 — Tag on write, verify on delete

Every created record carries the tag from `Settings.demo_tag`:
- LearnUpon users: custom user data field `demo_source`
- LearnUpon courses: tag prefixed in title, e.g. `[MCP-DEMO] Integrations Masterclass`
- LearnUpon groups: tag prefixed in name
- HubSpot objects: custom boolean property `mcp_demo_record` = true

Before any delete, fetch the record and confirm the tag. If the tag is missing or the fetch fails, **skip that deletion, log it as a warning, and continue with the rest**. This catches stale manifests and ID collisions.

### Layer 3 — Dry run is the default

- Every destructive or writing action previews first and requires explicit confirmation
- Reset requires a typed confirmation in a prompt dialog (e.g. user types `RESET UC2`)
- Every run writes to the `_Log` tab with run_id, intended counts, and actual outcomes

### Layer 4 — LockService

Three people share this sheet. Wrap every write action in `LockService.getScriptLock()` with a short timeout and fail cleanly if another run is in progress. Two simultaneous seeds would corrupt the manifest.

### Persistent vs disposable

**Persistent — created once, never deleted by this toolkit.** These are join keys; nothing in the story depends on their creation dates, and recreating them risks breaking the email-based join.
- LearnUpon users
- HubSpot contacts
- HubSpot companies

Handle as **upsert only**: look up by natural key (email; company name/domain), create if absent, update attributes in place. Record in `_Manifest` with `class = persistent` so `verify` knows them and the email→ID map is cacheable, but reset skips them.

**Disposable — safe to delete and rebuild.** Everything carrying a story-critical date, plus the structures holding them.
- LearnUpon enrollments, completions, group memberships, courses, groups
- HubSpot tickets, deals, associations

Record with `class = disposable`. Reset removes only these.

**Schema — structural, excluded from normal reset.** HubSpot custom properties, property options, pipelines. Record with `class = schema`. Only removed via an explicit `--include-schema` equivalent menu action. An orphaned custom property is harmless; deleting one another record depends on is not.

### Explicit prohibitions

- Never delete by search results, name pattern, or date range
- **Never call `DELETE /users/{id}` on LearnUpon.** User deletion is out of scope. If a user must go, a human does it in the UI.
- Never delete or archive HubSpot contacts or companies
- Never use HubSpot's GDPR delete endpoint (permanent, unrecoverable) — use standard archive
- Never write credentials into a cell, a log, or the manifest
- Never assume a batch response of 200 means success — check `numErrors` and per-item results

---

## Runtime and tooling

- **Google Apps Script**, container-bound to the workbook
- **Develop locally with `clasp`** (`@google/clasp`) so files are real files under version control. `clasp pull` / `clasp push`. Do not develop in the web editor.
- Target modern V8 runtime; set in `appsscript.json`
- No external libraries

### Apps Script constraints that shape the design

| Constraint | Value | Implication |
|---|---|---|
| Max execution time | **6 minutes**, both consumer and Workspace | Phase every operation. Never build "Seed Everything". |
| Execution model | Synchronous, single-threaded | Each fetch waits. ~550 calls ≈ 2–4 minutes if run as one job. |
| UrlFetch daily quota | 20,000 consumer / 100,000 Workspace | Non-issue at our volume. |
| Per-request timeout | ~60 seconds | Set generous but finite retry budgets. |
| State between runs | None natively | Manifest tab + idempotency give us resumability. |
| `Math.random()` | Not seedable | Implement deterministic jitter. See below. |

**Phasing is the answer to the 6-minute limit.** Each menu action does one bounded thing and finishes in well under a minute. Because seeding is idempotent against the manifest, a timeout just means re-running that phase. Do not build continuation triggers — they add complexity we don't need.

`UrlFetchApp.fetchAll()` is appropriate for **HubSpot batch endpoints** but **not for LearnUpon**, where firing parallel requests would breach the ~5 req/sec pacing. LearnUpon calls go sequentially with pacing.

---

## Credentials

Stored in **Script Properties**, never in the sheet. Provide a `Setup → Check Credentials` menu action that verifies presence and connectivity without printing values.

Required properties:

```
LEARNUPON_SUBDOMAIN      e.g. acmetraining
LEARNUPON_API_USERNAME   API key pair, username half
LEARNUPON_API_PASSWORD   API key pair, password half
HUBSPOT_ACCESS_TOKEN     private app token
HUBSPOT_PORTAL_ID
```

LearnUpon base URL: `https://{LEARNUPON_SUBDOMAIN}.learnupon.com/api/v1/`, HTTP Basic auth.
HubSpot: `https://api.hubapi.com`, `Authorization: Bearer {token}`.

**Note for the human operator:** LearnUpon API keys are generated at Settings → Integrations → API Keys, and generating new keys breaks existing integrations — check whether keys already exist before creating any. HubSpot private app needs read+write scopes for contacts, companies, deals, tickets, plus properties and pipelines if schema creation is scripted.

**Access caveat to surface in the README tab:** anyone with edit access to the sheet can open the script editor and read Script Properties. Acceptable for demo-portal credentials shared among the project team; document it rather than leaving it implicit.

---

## Phase 0: spike before building

Four assumptions underpin the design and none are confirmed. Resolve these first, report findings, then stop for review before building the full toolkit. Write throwaway functions in `Spike.gs`. Use one or two records and clean up after each test.

### Spike 1 — Can a completed enrollment be deleted?
LearnUpon docs say the delete call permanently removes enrollments in Not started and In progress status, and that "by default" it does not delete enrollments with Completed status. Check the "Optional parameters to delete enrollments" table at https://docs.learnupon.com/api/ for an override flag and test it.

Create a test user, enroll, mark complete with a backdated date, then attempt `DELETE /enrollments/{id}` with and without any override found.

**Report:** can completed enrollments be deleted, and how? This determines the refresh strategy. If not, the fallback is deleting and re-cloning the *course* (which takes its enrollment history with it) — viable because courses are disposable.

### Spike 2 — Is HubSpot ticket `createdate` writable via API?
Ticket create date is documented as system-set but user-editable, matching deal behavior. Contacts and companies reject it with `READ_ONLY_VALUE`.

Test `POST /crm/v3/objects/tickets` with `createdate` 120 days in the past; read it back. Then test PATCH on an existing ticket.

**Report:** settable on create? On update? If neither, the entire design switches to a custom `reported_date` property — so build the expander so this is a one-line swap, not a refactor.

### Spike 3 — Do backdated completions surface correctly in MCP reporting?
Mark an enrollment complete with `date_completed` 120 days in the past, then query the LearnUpon MCP `run_progress_report` for that user and course.

**Report:** does the backdated completion date appear? Does the report expose an enrolled/assigned date that would reveal a completion predating its own enrollment? This decides whether enrollment creation dates matter at all.

### Spike 4 — Does clone + publish produce a usable course?
A source course must be built manually in the UI first (a page module plus a short exam). Then `POST /courses/{id}/clone`, capture the returned GUID, clone again using the GUID, publish, rename, enroll a user, mark complete.

**Report:** does the clone carry content? Does the GUID flow work as documented? How long does cloning take, and does it need polling?

---

## The workbook is generated by code

Do not write setup instructions for a human to follow. Build `Schema.gs` with a `setupWorkbook()` function, exposed as `Setup → Create / Repair Workbook`, that **idempotently**:

- Creates any missing tab with correct headers and frozen header row
- Creates/updates named ranges for every dropdown source
- Applies data validation to every key column
- Writes computed-column formulas (see People.email below)
- Applies conditional formatting (see below)
- Protects `_Manifest`, `_Validation`, and `_Log` from manual edit
- Never destroys existing user-entered rows

Running it twice must be safe. Running it after someone deletes a column must restore it.

### Conditional formatting worth building in
- `Tickets`: a computed delta column between windows, red/green scaled — makes the deflection story visible at a glance
- `_Validation`: red for errors, amber for warnings
- `TicketCategories`: highlight rows where `is_deliberate_gap = TRUE`, so nobody fills one by accident

---

## Tab schemas

Column names are exact. `→` marks a dropdown sourced from a named range. `ƒ` marks a computed formula column the script writes and users don't edit.

### `README`
Free text. `setupWorkbook()` populates it: the T-scale convention, what each tab is for, how to run a seed, the credentials access caveat, and a warning that `_` tabs are script-owned.

### `Settings` — key/value pairs, vertical
| key | value |
|---|---|
| `demo_tag` | `MCP-DEMO` |
| `t_anchor_mode` | `today` or `pinned` → |
| `t_anchor_date` | ISO date, used when pinned |
| `prng_seed` | integer |
| `learnupon_subdomain` | display only; auth comes from Script Properties |
| `hubspot_portal_id` | display only |

### `Accounts` — shared reference, ~5 rows
`account_key` · `company_name` · `domain` · `industry` · `plan_tier` → · `arr` · `renewal_offset` · `learner_count` · `csm_owner_email` · `lu_group_name` ƒ (= `company_name`) · `notes`

`learner_count` drives generation of filler learners beyond the named personas.

### `People` — shared reference, named personas only (~15 rows)
`person_key` · `first_name` · `last_name` · `email` ƒ · `job_title` · `account_key` → · `lu_user_type` → (`learner`/`manager`/`admin`) · `notes`

**`email` is computed, not typed:**
`=IF(LEN($B2)=0,"",LOWER($B2&"."&$C2&"@"&IFERROR(VLOOKUP($F2,AccountsKeyDomain,2,FALSE),"MISSING-ACCOUNT")))`

A hand-typed email that doesn't match its HubSpot contact silently breaks the cross-system join and would likely survive until demo day. Making it computed removes the failure mode. Validation must reject any `MISSING-ACCOUNT` value.

Filler learners are **not** listed here. The expander generates them deterministically from `Accounts.learner_count` using a stable scheme: `{account_key}.learner{NN}@{domain}`, with generated display names. They are persistent and must be recorded in the manifest.

### `Courses` — shared reference, ~10 rows
`course_key` · `title` · `family` → (`onboarding`/`feature`/`premium`) · `clone_source_course_id` · `launch_offset` · `linked_category_key` → · `notes`

### `TicketCategories` — shared reference
`category_key` · `label` · `course_key` → (blank when a gap) · `is_deliberate_gap` → (`TRUE`/`FALSE`) · `notes`

Story 1 of scenario 2 depends on gaps existing. Validation must fail if a row has `is_deliberate_gap = TRUE` and a non-empty `course_key`. This turns story protection into an automated test.

### `Enrollments` — event declarations, all use cases
`row_id` · `use_case` → (`1`/`2`/`3`) · `account_key` → · `course_key` → · `person_keys` (optional, comma-separated) · `enroll_count` · `enroll_offset` · `due_offset` · `complete_count` · `complete_window_start` · `complete_window_end` · `remainder_status` → (`not_started`/`in_progress`) · `notes`

Two declaration modes:
- **Group-level:** leave `person_keys` blank. The expander enrolls named personas for that account first, then filler learners, up to `enroll_count`.
- **Person-level:** list `person_keys` explicitly; takes precedence over `enroll_count`.

Completions are distributed across `[complete_window_start, complete_window_end]` with deterministic jitter.

### `Tickets` — event declarations
`row_id` · `use_case` → · `account_key` → · `category_key` → · `window_start` · `window_end` · `count` · `contact_person_keys` (comma-separated, rotated round-robin) · `priority` → · `status` → · `resolution_hours` · `notes`

One row per account × category × window. The before/after deflection story is two rows per account.

### `Deals` — event declarations
`row_id` · `use_case` → · `account_key` → · `pipeline` → · `stage` → · `amount` · `close_offset` · `deal_type` → (`new`/`renewal`/`expansion`) · `notes`

### `_Manifest` — script-owned, protected
`run_id` · `created_at` · `platform` → (`learnupon`/`hubspot`) · `object_type` · `class` → (`persistent`/`disposable`/`schema`) · `external_id` · `natural_key` · `use_case` · `parent_external_id`

Flat table, not nested JSON — a human must be able to read and filter it before authorizing a reset. `parent_external_id` supports dependency-ordered deletion.

### `_Validation` — script-owned, protected
`checked_at` · `severity` → (`error`/`warning`) · `tab` · `row` · `column` · `message`

### `_Log` — script-owned, protected
`timestamp` · `run_id` · `action` · `phase` · `platform` · `object_type` · `intended` · `succeeded` · `failed` · `notes`

---

## Determinism

`Math.random()` is not seedable in Apps Script, and reproducibility is a hard requirement.

**Do not use a sequential seeded PRNG.** With one, inserting a ticket row shifts every subsequent random value and the whole dataset changes — unacceptable in a sheet three people edit. Instead derive jitter from a **hash of the record's own identity**:

```javascript
function jitter(identityString, seed, rangeSize) {
  const h = hash32(identityString + '|' + seed);
  return h % rangeSize;
}
```

Identity strings are stable and content-derived, e.g. `ticket|fernpath|integrations|T-180..T-90|3` for the fourth ticket in that declaration. Inserting an unrelated row changes nothing else. Implement a small 32-bit string hash (FNV-1a or murmur3) in `Random.gs` with unit tests asserting stability.

Requirement: two runs with the same sheet contents and the same `prng_seed` produce identical output. Adding one row changes only records derived from that row.

---

## Date model

All offsets in the sheet are relative to anchor `T`, resolved at run time from `Settings`. Accept `T`, `T-90`, `T+30`. Reject anything else with a clear validation error naming the tab, row, and column.

`t_anchor_mode = pinned` exists for reproducible testing; `today` is the normal mode.

### Writability, which dictates what refresh can move

| Field | Platform | Writable after creation | Refresh approach |
|---|---|---|---|
| Ticket `createdate` | HubSpot | Pending spike 2 | Shift forward |
| Deal `closedate`, custom dates | HubSpot | Yes | Shift forward |
| Enrollment `due_date`, `expires_at` | LearnUpon | Yes, `PATCH /enrollments/{id}` | Shift forward — our "overdue training" lever |
| Completion `date_completed` | LearnUpon | No — `markcompletes` is write-once | Delete + recreate only |
| Enrollment `created_at` | LearnUpon | No | Delete + recreate only |
| Contact/company `createdate` | HubSpot | No | Nothing depends on it |

So refresh has two paths:
1. **Safe path (default):** shift HubSpot ticket/deal/custom dates and LearnUpon due dates. Pure updates, no deletion. This is what runs weekly or monthly.
2. **Rebuild path (explicit, destructive):** delete and recreate enrollments to reset assignment and completion dates. Only viable if spike 1 succeeds. Must warn clearly and require typed confirmation.

---

## Expansion logic

`Expand.gs` turns declarations into concrete record lists. Keep it pure and side-effect free — it must be unit-testable without API calls, and dry-run previews come from it.

Responsibilities:
- Resolve every key reference against the reference tabs
- Generate filler learners from `Accounts.learner_count`
- Select enrollees (named personas first, then fillers) or honor `person_keys`
- Distribute `count` records across a date window with hash-based jitter
- Assign completion status: `complete_count` completed, remainder split per `remainder_status`
- Rotate ticket contacts round-robin through `contact_person_keys`
- Return a structured plan: `{ learnupon: { users: [], groups: [], ... }, hubspot: { ... } }`

Dry run renders this plan as counts by object type plus a sample of concrete records. Seed consumes the same plan.

---

## Validation

`Validate.gs`, exposed as its own menu action, writes to `_Validation` and acts as a **hard gate**: seed refuses to run when any `error` exists.

Required checks:
- Every `account_key`, `course_key`, `person_key`, `category_key` resolves to a reference row
- No duplicate keys in any reference tab
- No `MISSING-ACCOUNT` in computed emails; all emails unique
- Every offset parses as `T`, `T±n`
- `complete_count` ≤ `enroll_count` ≤ available learners for that account
- Date ordering per enrollment row: `course.launch_offset` ≤ `enroll_offset` ≤ `complete_window_start` ≤ `complete_window_end`
- Ticket `window_start` < `window_end`
- `is_deliberate_gap = TRUE` rows have empty `course_key`
- Every `linked_category_key` on a course resolves, and isn't a deliberate gap
- Ticket contacts belong to the ticket's account
- Warning (not error) when a course has zero enrollments across all use cases, or an account has zero tickets and zero enrollments

Also add a **cross-tab reconciliation warning**: for each category, total ticket counts per window across accounts, and surface the totals so a reviewer can check them against the scenario spec. Don't hard-fail — the spec may legitimately change.

---

## Menu

```
MCP Demo Seeder
├─ Setup
│  ├─ Create / Repair Workbook
│  └─ Check Credentials
├─ Validate
├─ Preview (dry run)
│  ├─ Seed Plan
│  └─ Reset Plan
├─ Seed
│  ├─ Reference Data  (users, groups, memberships)
│  ├─ Courses          (clone + publish)
│  ├─ Use Case 1  ▸ Enrollments │ Completions │ HubSpot
│  ├─ Use Case 2  ▸ Enrollments │ Completions │ HubSpot
│  └─ Use Case 3  ▸ Enrollments │ Completions │ HubSpot
├─ Refresh
│  ├─ Roll Dates Forward (safe)
│  └─ Rebuild Enrollments (destructive)
├─ Reset
│  ├─ Use Case 1 │ 2 │ 3
│  ├─ All Disposable Data
│  └─ Schema Objects (rarely needed)
└─ Verify
```

Every write action: check lock → validate → build plan → show confirmation dialog with counts → execute → log. Destructive actions require typed confirmation.

---

## Reset order and rules

Dependencies matter — LearnUpon will not delete a course with learners still enrolled.

**LearnUpon:** enrollments → group memberships → courses → groups
**HubSpot:** associations → tickets → deals

Users, contacts, and companies are never deleted. Schema objects only via the explicit menu action.

- Unenroll before deleting courses: get enrollments by course ID, delete each by enrollment ID
- Deleting a group does not delete its members — the behavior we want. Users survive; memberships rebuild on next seed.
- HubSpot deletes are archives, recoverable ~90 days. Prefer them.
- Reset must be resumable: treat 404 on delete as success, and re-running should complete whatever remains
- Remove manifest rows only after the corresponding delete succeeds, so a partial run leaves an accurate ledger
- After reset, `verify` must confirm the persistent roster is intact and report its counts. **A reset that removed a user is a bug, not a cleanup.**

---

## API reference

### LearnUpon (v1, Basic auth)

| Purpose | Call |
|---|---|
| Create user | `POST /users` |
| Update user | `PUT /users/{id}` |
| Find users | `GET /users` (paginate) |
| Create group | `POST /groups` |
| Add member | `POST /groups/{id}/memberships` |
| Remove member | `DELETE /groups/{group_id}/memberships/{membership_id}` |
| Assign course to group | `POST /groupcourses` |
| Create course | `POST /courses` |
| Clone course | `POST /courses/{id}/clone` — returns a GUID; reuse it for further clones or the call errors |
| Publish course | `POST /courses/{id}/publish` |
| Delete course | `DELETE /courses/{id}` — fails if learners enrolled |
| Enroll | `POST /enrollments` — optional `due_date`, `expires_at`, `re_enroll_if_completed` |
| Update enrollment | `PATCH /enrollments/{id}` — due date and expiry only |
| Delete enrollment | `DELETE /enrollments/{id}` — see spike 1 |
| **Backdated completion** | `POST /markcompletes` with `enrollment_id`, `date_completed`, `status`, `percentage`, `notes` |
| Bulk enroll/unenroll | `POST /bulk_operations` — async, poll for status |

Constraints:
- Pace at ~5 req/sec. Read `X-LU-Rate-Limit-Remaining-Minute` and `X-LU-Rate-Limit-Remaining-Week`, back off on both. **The weekly ceiling is real** — put a hard call cap in the client so a retry loop cannot burn a week's quota.
- Pagination 500/page; follow `LU-Has-Next-Page`, don't guess
- No bulk-upsert for users — one call each. Fine, and paid once since users are persistent. Cache the email→user_id map in the manifest.
- Dates `YYYY-MM-DD`; timestamps ISO 8601 UTC (`2026-03-07T13:00:00Z`)
- Escape apostrophes in names, or avoid them in the dataset
- Name and description fields have character limits that will fail a POST if exceeded

### HubSpot (v3/v4, Bearer token)

| Purpose | Call |
|---|---|
| Batch create | `POST /crm/v3/objects/{type}/batch/create` — 100 per call, one request against quota |
| Batch update | `POST /crm/v3/objects/{type}/batch/update` |
| Archive | `POST /crm/v3/objects/{type}/batch/archive` |
| Associations | `PUT /crm/v4/objects/{fromType}/{fromId}/associations/{toType}/{toId}` |
| Create property | `POST /crm/v3/properties/{objectType}` |
| Pipelines | `/crm/v3/pipelines/{objectType}` |
| Owners | `GET /crm/v3/owners` (read-only) |

Constraints:
- Burst ~100–190 requests per 10s plus a daily cap. Irrelevant at our volume.
- **Search API is far stricter (~4 req/sec).** Never build a search-per-record lookup loop — fetch once, build a local email→ID map.
- Batch responses can be partially successful: inspect `numErrors` and per-item errors, and log failures individually
- `createdate` is read-only on contacts and companies; writable on deals; on tickets pending spike 2

Expected total volume: ~550 LearnUpon calls, ~30 HubSpot batch calls. Capacity is not the constraint — correctness and safety are.

---

## Build order

1. **Phase 0** — the four spikes. Report findings and stop for review.
2. **Phase 1** — `Schema.gs` (`setupWorkbook`), `Config.gs`, `Dates.gs`, `Random.gs`, `Manifest.gs`, `Menu.gs`. No API calls. Unit-test the date resolver and the hash jitter.
3. **Phase 2** — `Validate.gs` and `Expand.gs` with dry-run preview. Still no API calls. At this point the whole plan is inspectable.
4. **Phase 3** — `LearnUpon.gs` client plus reference-data and course seeding.
5. **Phase 4** — enrollments and completions.
6. **Phase 5** — `HubSpot.gs` client plus companies, contacts, tickets, deals, associations.
7. **Phase 6** — `Reset.gs` and `Verify.gs`.
8. **Phase 7** — `Refresh.gs`, safe path first.

**Build reset and verify before running a large seed.** Being able to clean up is more urgent than being able to create at scale, and it's the natural instinct to get backwards. Test reset against a five-record seed before a full one.

---

## Definition of done

- `Setup → Create / Repair Workbook` builds the full workbook from empty, and re-running is harmless
- A teammate with no script knowledge can fill in the reference and event tabs using only dropdowns and typed offsets
- `Validate` catches every class of error listed above and blocks seeding
- `Preview` shows an accurate plan without touching either platform
- Each seed phase completes in well under 6 minutes
- Two runs with identical sheet contents produce identical records
- `Reset` removes all event data while leaving users, contacts, and companies fully intact, confirmed by `Verify`
- Re-seeding after a reset produces an equivalent dataset with fresh dates
- No code path can delete a user, contact, company, or any untagged or unmanifested record

---

## Sources

- LearnUpon API guide — https://docs.learnupon.com/api/
- LearnUpon KB, using the API — https://support.learnupon.com/hc/en-us/articles/360003084338
- HubSpot object APIs — https://developers.hubspot.com/docs/guides/crm/using-object-apis
- HubSpot default ticket properties — https://knowledge.hubspot.com/properties/hubspots-default-ticket-properties
- HubSpot usage guidelines — https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines
- Apps Script quotas — https://developers.google.com/apps-script/guides/services/quotas
