# CLAUDE.md — MCP Demo Data Seeder (Google Apps Script + Sheets)

> Working spec. Supersedes `docs/original-brief.md`, the earlier thinking-out-loud draft, which is
> kept only for provenance. Decisions recorded here were agreed in the 2026-08-04 design session.

## What we're building

A Google Sheets workbook plus container-bound Apps Script that seeds, refreshes and safely removes
demo data in **LearnUpon** (and later **HubSpot**), so an AI assistant querying those platforms via
MCP can answer cross-system questions about training-driven outcomes.

The Sheet is the authoring surface. Sales engineers declare *intent* — "Alderfield has 16 users, 4
admins, 25% of required training complete, due dates two weeks before go-live" — and the script
expands declarations into concrete records with deterministic dates.

**Target:** UNBOUND 2026, ~4 weeks from 2026-08-04. Scenario 1 (Customer Onboarding Health) is the
demo we harden first, because it runs almost entirely on writable fields.

## Scope decisions

| Decision | Rationale |
|---|---|
| This repo owns the **seeder only** | Prompt library, runbook and recording live elsewhere |
| **LearnUpon first, HubSpot second** | HubSpot token/scopes unresolved; nothing about this order costs rework |
| Scenario 1 only, use-case-scoped columns from day one | Scenarios 2 and 3 slot in as more rows, not more code |
| Each use case gets **its own accounts and people** | One company can't credibly be mid-onboarding *and* renewing with expansion signals |
| Users created **once**, at initial seed | No recurring user creation, so invitation emails are a non-issue |
| Refresh = **shift due dates only** | Spike 3: completed enrollments cannot be deleted, so re-enrolling is not available |

## Findings that shaped the design

Established by read-only probes of the ACME portal's reporting API on 2026-08-04
(`list_report_columns`, `lookup_enums`, `lookup_custom_user_data_definitions`, `lookup_groups`).

**1. Learning Journeys are not a reportable dimension.** The enrollments report exposes courses
only — no journey or learning-path column or filter. So "required training" cannot be defined by a
Journey object.

**Instead, the group is the denominator.** Each account's users are in a `Customer: <Company>` group
and are enrolled in *nothing but* that use case's required courses. A progress report filtered by
group therefore returns exactly the required enrollments, and the completion percentage falls out
with no explanation needed. A Journey may be built by hand in the UI for realism — nothing in the
data may depend on it.

**Invariant this creates:** never enroll a seeded user in a course outside their use case's required
set. It would silently corrupt every percentage in the demo.

**2. Everything else Scenario 1 needs is reportable.**

| Story needs | Column | Filterable |
|---|---|---|
| Overdue | `due_date_passed`, status `8 = Past Due` | yes |
| When assigned | `created_at` | yes |
| Stalled since | `date_last_accessed` | no |
| Partial progress | `percentage_complete`, `percentage` | no |
| Company | `group_titles` | yes |
| Status | `status_id` | yes |

Enrollment statuses: `1` not started, `2` in progress, `3` completed, `4` passed, `5` failed,
`8` past due.

**3. Admin vs learner is not reportable.** LearnUpon has membership types (member/admin/instructor/
manager) but the enrollments report does not expose them. "Which of these people are administrators?"
therefore depends entirely on a **custom user data field holding job title**. This field is
load-bearing for Scenario 1 Story 3.

ACME's existing `* Job Title *` field is type 4 (String choice — a dropdown), so it can only hold
pre-defined options, and its label renders badly in a demo answer. Michael is creating two clean
**String** (free-text) fields instead.

Confirmed against the API docs on 2026-08-05: `POST /users` and `PUT /users/{id}` accept a
`CustomData` object **keyed by field label**, case-insensitive and space-tolerant, with an opt-in
`use_definition_ids` mode. So the workbook stores field labels, and never needs a `ud_` id at all.
`GET /users/customuserdata` lists the definitions, which is how `Setup → Check Custom Fields`
verifies a portal before we write anything.

Field types: `1` String (free text — what we need), `2` decimal, `3` integer, `4` String choice
(dropdown), `5`/`6` numeric choice, `7` date. **A portal gets 10 custom user data fields by default**;
more requires a CSM request. ACME has had its limit raised (27 defined); the test portal may not.

**4. Tagging must stay invisible in the narrative.** ACME holds 60+ groups of other people's demo
data, so tagging matters — but a `[MCP-DEMO]` course-title prefix would appear in demo answers.

| Object | Tag | Why |
|---|---|---|
| Course | `reference_code = MCPDEMO-<COURSE_KEY>` | Real field, invisible in narrative |
| Group | title prefix `Customer: ` | Matches the portal's existing `Customer: ACME` convention; reads naturally |
| User | `demo_source` custom field | Never deleted, so this is for human recognition in the UI |

## Safety model

Both platforms hold data belonging to other people. **This toolkit must never delete, modify or
archive a record it did not create.**

### Layer 1 — `_Manifest` is the only authority for deletion

Every record created is appended to `_Manifest` with its platform ID. Reset reads *only* from the
manifest. It must never discover records to delete by searching, filtering or querying the platform.
If a record isn't in the manifest, it doesn't get touched — even if it looks like ours.

### Layer 2 — tag on write, verify on delete

Before any delete, fetch the record and confirm its tag. Missing tag or failed fetch → skip that
deletion, log a warning, continue with the rest. This catches stale manifests and ID collisions.

### Layer 3 — dry run is the default

Every writing or destructive action previews first and requires confirmation. Destructive actions
require typed confirmation. Every run appends to `_Log` with run_id, intended counts and outcomes.

### Layer 4 — LockService

Three people share the sheet. Every write action wraps in `LockService.getScriptLock()` with a short
timeout and fails cleanly if another run is in progress.

### Object classes

| Class | Objects | Reset touches it? |
|---|---|---|
| `persistent` | LU users, groups, group memberships, **courses** | **Never** |
| `disposable` | LU enrollments, **completed or not** | Yes — the only thing reset deletes |
| `schema` | custom field values, group-course assignments | Explicit menu action only |

Courses are never deleted. Michael confirmed this on 2026-08-05: leaving them costs nothing, and
deleting one does not remove its completed enrollments anyway, so there is no cleanup benefit to
offset the risk.

There was briefly a fourth class, `permanent`, for completed enrollments. It was removed on
2026-08-06 when spike 3's conclusion turned out to rest on sending a boolean where the API wanted a
string. Nothing in the demo dataset is permanent.

### What can and cannot be cleaned up

Established by spike, not assumption. This table is the honest answer to "can we undo it?".

| Object | Removable? | How |
|---|---|---|
| HubSpot tickets, deals | **Yes** | archive, recoverable ~90 days |
| HubSpot contacts, companies | **Yes** — manifest-recorded and tag-verified only | archive |
| HubSpot custom properties, pipelines | Yes, in order: records first, then schema | delete |
| LearnUpon not-started enrollments | **Yes** | `DELETE /enrollments/{id}` |
| LearnUpon courses, groups, memberships | **Yes** | `DELETE` |
| LearnUpon completed enrollments | **Yes** | `DELETE /enrollments/{id}` with body `{"remove_from_history":"true"}` |
| LearnUpon users | Only by lifting the prohibition | `DELETE /users/{id}` |

**Everything except users is now removable.** `DELETE /users/{id}` stays prohibited — that rail is
about not destroying a shared portal's roster, not about capability — but enrollments, completions,
courses, groups and memberships can all go. Deleting a user is no longer the only route to removing a
completion, which was the argument for lifting the prohibition; that argument is gone.

### Explicit prohibitions

- Never delete by search result, name pattern or date range
- **Never call `DELETE /users/{id}`.** User deletion is out of scope; a human does it in the UI
- HubSpot contacts and companies **may** be archived, but only when `_Manifest` records them and the
  demo tag verifies — relaxed 2026-08-06 at Michael's request, because the portal is DEVELOPER_TEST
  and cleanup matters more than the extra rail. Archive is recoverable for ~90 days.
  **Never use the GDPR delete endpoint** — that one is permanent and unrecoverable.
- Never write credentials into a cell, a log or the manifest
- Never treat a batch HTTP 200 as success — check per-item results
- Never enroll a seeded user outside their use case's required course set (see invariant above)

## Runtime constraints

Google Apps Script, container-bound, V8. **No clasp** — files are pasted into the editor by hand, so
keep them small and single-purpose: a fix should mean re-pasting one file, not a monolith.

| Constraint | Value | Implication |
|---|---|---|
| Max execution time | 6 minutes | Phase every operation; never build "Seed Everything" |
| Execution model | Synchronous, single-threaded | ~550 LearnUpon calls ≈ 2–4 min if run as one job |
| Per-request timeout | ~60s | Generous but finite retry budgets |
| State between runs | None | Manifest + idempotency give resumability |
| `Math.random()` | Not seedable | Hash-based jitter instead (see Determinism) |

Phasing is the answer to the 6-minute limit. Each menu action does one bounded thing. Because
seeding is idempotent against the manifest, a timeout just means re-running that phase. No
continuation triggers.

`UrlFetchApp.fetchAll()` suits HubSpot batch endpoints but **not** LearnUpon, where parallel requests
would breach the ~5 req/sec pacing. LearnUpon calls go sequentially with pacing.

## Repo layout

```
CLAUDE.md                 this spec
INSTALL.md                paste order and first run
apps-script/              the files that get pasted into the editor
  Schema.gs               setupWorkbook, tab/column contract, README tab
  Config.gs               settings, credentials, sheet I/O, locking, logging
  Dates.gs                the T / S / G offset grammar
  Random.gs               FNV-1a hash, jitter, filler-learner names
  Expand.gs               declarations -> plan, preview
  Validate.gs             the hard gate
  Scenario1.gs            the worked example dataset
  Tests.gs                unit tests
  Manifest.gs             the ledger, and the only authority for deletion
  Seed.gs                 the four write phases
  Reset.gs                reset + verify
  LearnUpon.gs            HTTP client (pacing, retries, call cap) + read-only setup checks
  Menu.gs                 menu wiring
  appsscript.json         V8, UTC
tools/verify-local.js     runs the pure layers under Node with Sheets stubbed
tools/seed-local.js       runs the REAL seed/reset/verify against the test portal, sheet faked
tools/probe-api.js        read-only API diagnostics
tools/spike.js            the spike harness; the only tool that writes to a portal
docs/original-brief.md    superseded first draft, kept for provenance only
```

**`node tools/verify-local.js` is the development loop.** Without clasp, the alternative is pasting
into the editor and clicking, so anything that can be checked locally should be. It builds an
in-memory workbook from `Scenario1.gs` — computing the formula columns exactly as the sheet does —
then runs the unit tests, prints the plan summary and runs validation. It cannot exercise `Schema.gs`
or `Config.gs`, which touch `SpreadsheetApp` and `UrlFetchApp`; those need a real run.

## Credentials

Script Properties only, never the sheet. Keyed per environment so the throwaway test portal and ACME
can coexist:

```
LU_TEST_SUBDOMAIN   LU_TEST_USERNAME   LU_TEST_PASSWORD
LU_DEMO_SUBDOMAIN   LU_DEMO_USERNAME   LU_DEMO_PASSWORD
HS_TEST_TOKEN       HS_DEMO_TOKEN      HS_DEMO_PORTAL_ID
```

`Settings.environment` (`test` | `demo`) selects the set. Every write dialog states which portal it
is about to hit. `Setup → Set Credentials` writes them; `Setup → Check Credentials` verifies
connectivity without printing values.

**Access caveat, documented on the README tab:** anyone with edit access to the sheet can open the
script editor and read Script Properties. Acceptable for demo-portal credentials shared among the
project team, but say so rather than leaving it implicit.

## Date model

All offsets resolve at run time against anchor `T` from `Settings`. The grammar has three bases,
because Scenario 1 needs per-account anchoring:

| Token | Base | Example |
|---|---|---|
| `T`, `T±n` | The global anchor | `T-90` |
| `S`, `S±n` | That account's onboarding start | `S+11` |
| `G`, `G±n` | That account's target go-live | `G-14` |

Any offset column also accepts a **range**, `A..B`, which is jittered per record:
`due_offset = G-40..G-5` gives each enrollment its own due date inside that window, so overdue
counts emerge from the data instead of being declared. Anything else is a validation error naming
tab, row and column.

`Accounts.onboarding_start_offset` must be `T`-based (it defines `S`). `target_go_live_offset` may be
`T`- or `S`-based.

### Writability, which dictates what refresh can move

| Field | Platform | Writable after creation | Refresh approach |
|---|---|---|---|
| Enrollment `due_date`, `expires_at` | LearnUpon | Yes, `PATCH /enrollments/{id}` | Shift forward — the overdue-training lever |
| Completion `date_completed` | LearnUpon | Not directly — but the enrollment can be deleted and remade | Rebuild path |
| Enrollment `created_at` | LearnUpon | Assume no (spike 2) | Delete + recreate resets it anyway |
| Deal `closedate`, custom dates | HubSpot | Yes | Shift forward |
| Ticket `createdate` | HubSpot | Pending spike | Shift forward |
| Contact/company `createdate` | HubSpot | No | Nothing depends on it |

**Consequence agreed in design:** enrollment age is not demonstrable. "Assigned 47 days ago and
never started" becomes "**due 18 days ago and still not started**" — achievable, and a sharper
finding.

Two refresh paths:
1. **Safe (default):** shift enrollment due dates and HubSpot ticket/deal dates. Pure updates.
2. **Rebuild (explicit, destructive):** delete and recreate enrollments so completion dates move.
   Typed confirmation. Bounded by the client call cap, so it reports what remains and is re-runnable.
   Needed for the established cohort; the safe path alone is enough for in-flight accounts.

## Determinism

`Math.random()` is not seedable, and reproducibility is a hard requirement. **Do not use a sequential
seeded PRNG** — inserting one row would shift every subsequent value and rewrite the whole dataset,
unacceptable in a sheet three people edit.

Instead derive jitter from a hash of the record's own identity:

```javascript
jitter('enr|alderfield|nce-admin-essentials|filler:alderfield:03', seed, spanDays)
```

Identity strings are stable and content-derived, so inserting an unrelated row changes nothing else.
FNV-1a 32-bit, unit-tested for stability.

Requirement: two runs with the same sheet contents and the same `prng_seed` produce identical output.
Adding one row changes only records derived from that row.

**Filler-learner identity:** generated as `filler:{account_key}:{NN}` with names drawn from a pool by
hash. Because the pool could change, **once a filler exists the manifest's recorded email wins** —
the manifest is the source of truth for filler identity after the first seed.

## Tab schemas

`→` marks a dropdown, `ƒ` marks a script-written formula column users don't edit. Column order is
part of the contract: the formulas reference it positionally.

### `Settings` — key/value
`environment` → · `demo_tag` · `t_anchor_mode` → · `t_anchor_date` · `prng_seed` ·
`job_title_field_label` · `demo_source_field_label` · `group_title_prefix` · `course_ref_prefix`

### `Accounts`
`account_key` · `use_case` → · `company_name` · `domain` · `industry` · `cohort` → · `plan_tier` → ·
`arr` · `onboarding_start_offset` · `target_go_live_offset` · `actual_go_live_offset` · `user_count` ·
`admin_count` · `required_complete_target` · `required_complete_actual` ƒ · `csm_owner_email` ·
`lu_group_title` ƒ · `notes`

`required_complete_actual` is a live formula so the author sees the percentage they will actually get
while typing. Validation warns when it drifts from the declared target by more than 2 points.

### `People` — named personas only
`person_key` · `use_case` → · `first_name` · `last_name` · `email` ƒ · `job_title` · `is_admin` → ·
`account_key` → · `notes`

`email` is computed, not typed. A hand-typed email that doesn't match its HubSpot contact silently
breaks the cross-system join and would survive until demo day. Validation rejects `MISSING-ACCOUNT`.

Filler learners are not listed here — the expander generates them from `user_count`/`admin_count`.

### `Courses`
`course_key` · `use_case` → · `title` · `reference_code` ƒ · `clone_source_course_id` · `notes`

### `Enrollments` — declarations
`row_id` · `use_case` → · `account_key` → · `course_key` → · `audience` → (`all`|`admins`) ·
`enroll_count_override` · `enroll_count` ƒ · `completed_count` · `in_progress_count` · `not_started_count` ƒ · `due_offset` ·
`complete_offset` · `in_progress_pct` · `last_access_offset` · `notes`

One row per account × course. Counts are explicit; percentages are derived and checked.

`enroll_count_override` was added 2026-08-10 for scenario 2, which needs states a headcount cannot
express: **0** means "this account enrolled nobody", and **16** of an 18-person account means
"they assigned it to most people". Both are findings in their own right. Blank falls back to the
audience headcount, so scenario 1 is unaffected.

### `PersonaStates` — pin a named person's state
`row_id` · `use_case` → · `person_key` → · `course_key` → · `status` → · `percentage` ·
`complete_offset` · `last_access_offset` · `notes`

Pins are applied first; the declared counts then fill the remaining slots. Validation errors if pins
exceed a declared count.

### `TicketCategories` · `Tickets` · `Deals`
`TicketCategories` carries `subject_templates`, a pipe-separated list of real ticket subjects picked
deterministically per ticket. They appear verbatim in demo answers, so the taxonomy owns its own
phrasing rather than the code generating `<Category> question` 230 times.

`Tickets` rows are declarations — one row per account × category × window with a `count`. The
expander spreads that count across the window with hash jitter, so 34 tickets over 90 days scatter
instead of landing on one date, and rotates the named filers round-robin. A category with `is_deliberate_gap = TRUE` must have an
empty `course_key`, and no course may exist whose title matches a gap label — this turns "don't let
anyone add a Data Import course" into an automated test.

### Script-owned, protected
- `_Manifest` — `run_id` · `created_at` · `platform` · `object_type` · `class` · `external_id` · `natural_key` · `use_case` · `parent_external_id` · `extra`
- `_Validation` — `checked_at` · `severity` · `tab` · `row` · `column` · `message`
- `_Log` — `timestamp` · `run_id` · `action` · `phase` · `platform` · `object_type` · `intended` · `succeeded` · `failed` · `notes`
- `_Preview` — rebuilt by every dry run

Flat tables, not nested JSON — a human must be able to read and filter the manifest before
authorizing a reset. Protection is **warning-only**, so three shared editors don't get locked out.

## The workbook is generated by code

`Schema.gs → setupWorkbook()`, exposed as `Setup → Create / Repair Workbook`, idempotently: creates
missing tabs with correct headers and a frozen header row, creates named ranges, applies data
validation, writes formula columns, applies conditional formatting, protects `_` tabs, and never
destroys user-entered rows. Running it twice is safe. Running it after someone deletes a column
restores the column.

## Expansion

`Expand.gs` is pure and side-effect free — unit-testable without API calls. Dry-run previews and the
seeder consume the same plan.

1. Resolve every key reference against the reference tabs
2. Generate filler learners to satisfy `user_count`/`admin_count`, admin slots filled first
3. Select enrollees: named personas in sheet order, then fillers
4. Apply `PersonaStates` pins, then fill remaining slots to the declared counts, ordered by hash
5. Resolve dates from offset tokens/ranges with hash jitter
6. Return `{ learnupon: { users, groups, memberships, courses, enrollments }, hubspot: {}, stats, warnings }`

`stats` carries per-account completion percentage and overdue counts, so preview and validation can
check the headline numbers rather than trusting them.

## Validation

`Validate.gs` writes to `_Validation` and is a **hard gate**: seed refuses to run while any `error`
exists. Errors cover unresolved keys, duplicate keys, `MISSING-ACCOUNT` emails, unparseable or
inverted offsets, counts exceeding headcount, pins exceeding counts, and gap-category violations.
Warnings cover target-vs-actual percentage drift, courses or accounts with no enrollments, cohort
inconsistencies, and in-flight accounts with no overdue enrollments (which would silently kill
Story 1).

## Three owners, one workbook, one portal

Nik owns scenario 1, Michael scenario 2, Brian scenario 3. All three seed into the same LearnUpon and
HubSpot portals, so isolation is possible for *authoring and operations* but not for *outcome*.

**`Settings.active_use_case`** scopes every action — Preview, Seed, Verify, Refresh, Reset. Destructive
actions require typing the scenario name (`RESET UC2`), and every dialog names the scenario and its
owner from the `Scenarios` tab. Courses are deliberately never scoped: they are shared infrastructure,
one record per title, and Reset never touches them.

**Nobody but the code owner pastes `.gs` files.** One shared script project, no version history, and a
partial paste breaks the tool for all three people mid-build. `LockService.getScriptLock()` is
project-wide, so concurrent runs queue rather than race.

Cross-scenario collisions are refused by validation rather than documented: company names (they become
group titles), email domains (the LearnUpon↔HubSpot join key), course titles (one catalogue), and the
deliberate content gaps. See `docs/working-together.md`, written for the two owners who do not read
this file.

## Menu

```
MCP Demo Seeder
├─ Setup ▸ Create / Repair Workbook │ Load Example Scenario (UC1) │ Set Credentials │ Check Credentials
├─ Validate
├─ Preview (dry run)
└─ Developer ▸ Run Unit Tests │ Show Resolved Dates
```

Seed / Refresh / Reset / Verify are added in later phases. Every write action: check lock → validate →
build plan → confirm with counts → execute → log.

## Reset order

**LearnUpon:** enrollments only. Users, groups, memberships and courses are never touched by reset.
Treat 404 on delete as success so reset is resumable. Remove a manifest row only after its delete
succeeds, so a partial run leaves an accurate ledger. After reset, `Verify` confirms the persistent
roster is intact — **a reset that removed a user is a bug, not a cleanup.**

## API reference

### LearnUpon (v1, Basic auth, `https://{sub}.learnupon.com/api/v1/`)

| Purpose | Call |
|---|---|
| Create / update user | `POST /users` · `PUT /users/{id}` — custom fields via `CustomData` keyed by label |
| Find users | `GET /users` (paginate 500/page, follow `LU-Has-Next-Page`) |
| List custom field definitions | `GET /users/customuserdata` — definitions only, not values |
| Create group · add member | `POST /groups` · `POST /groups/{id}/memberships` |
| Create course | `POST /courses` — `name`, `owner_id`, `reference_code`. Use this, not clone |
| Attach content | `POST /courses/add_module` — `course_id`, `module_id` (target must be draft) |
| Publish · delete course | `POST /courses/publish` · `DELETE /courses/{id}` |
| Clone course | `POST /courses/clone` — async, returns a guid, names the copy `<source> - Copy` |
| Enroll | `POST /enrollments` — optional `due_date`, `expires_at` |
| Update enrollment | `PATCH /enrollments/{id}` — due date and expiry only |
| Delete enrollment | `DELETE /enrollments/{id}` — not-started only; completed silently refuse |
| Backdated completion | `POST /markcompletes` — `enrollment_id`, `date_completed`, `status`; no `percentage` when completed |

Pace at ~5 req/sec. Read `X-LU-Rate-Limit-Remaining-Minute` and `X-LU-Rate-Limit-Remaining-Week` and
back off on both. **The weekly ceiling is real** — a hard call cap in the client stops a retry loop
burning a week's quota. Dates `YYYY-MM-DD`, timestamps ISO 8601 UTC. Avoid apostrophes in names.

**Measured volume for scenario 1** (from `tools/verify-local.js`): 127 users, 9 groups, 127
memberships, 4 courses, 223 enrollments, 192 backdated completions — roughly **700 sequential calls**,
about 2.5 minutes of wall clock at 5 req/sec. Comfortably inside the 6-minute limit only because it
is phased; a single "seed everything" action would not be. Capacity is not the constraint here —
correctness and safety are.

### HubSpot portal reconnaissance — 2026-08-06

Established with `tools/hubspot-probe.js`, entirely read-only apart from scope probes that carry a
deliberately invalid property so HubSpot rejects them after the auth check and before creating
anything.

| | |
|---|---|
| Portal id | **23399533** |
| Account type | **DEVELOPER_TEST** — not a production portal |
| Existing volume | 18 companies, 93 contacts, 34 deals, 28 tickets |

**All required scopes are present.** Read and write confirmed for companies, contacts, deals and
tickets; `crm.schemas.*` writable, so the seeder can create properties itself. The
`/oauth/v1/access-tokens/{token}` endpoint rejects `pat-`style private app tokens, so scopes cannot
be listed directly — capability probing is the only way to establish them.

**The portal is not empty.** 93 contacts and 34 deals belong to other people's demo work, so the same
manifest-only-deletion discipline applies here as in ACME.

**What exists, and what does not:**

| Need | State |
|---|---|
| `onboarding_start_date`, `target_go_live_date`, `actual_go_live_date` on companies | **All missing** — must be created |
| Onboarding deal pipeline (Kickoff → … → Go-Live) | **Missing.** Only "Sales Pipeline" (`default`) and "Course Enrollments" (`67673966`) |
| Ticket pipeline | "Support Pipeline" (`0`): New `1`, Waiting on contact `2`, Waiting on us `3`, Closed `4` |
| Ticket category property | **None.** Only one custom ticket property exists; everything category-ish is a `hs_*` internal |
| Owners | 8, all real LearnUpon staff |

The missing ticket category is load-bearing: Story 3 asks what Alderfield is filing tickets about,
and the whole of scenario 2 is gap analysis by category. It has to be a custom property.

### HubSpot spike results — 2026-08-06

| Question | Answer |
|---|---|
| Is ticket `createdate` settable on create? | **Yes** — asked 2026-04-08, got 2026-04-08 |
| Settable on update? | **Yes** — which makes ticket dates refreshable, not just seedable |
| Deal `closedate` backdatable? | **Yes** |
| Deal `createdate` backdatable? | **Yes** |
| Does archive work? | **Yes** — `DELETE /crm/v3/objects/{type}/{id}` returns 204, recoverable ~90 days |

So no `reported_date` fallback is needed: real HubSpot date fields carry the story, and because they
are settable on update, **the safe refresh path covers HubSpot completely**. This is the opposite of
LearnUpon, where completion dates are write-once and undeletable.

**`hubspot_owner_id` takes the OWNER id, not the USER id.** HubSpot issues a person both, and they
are different numbers: Michael is userId `48285255`, ownerId `268202805`. Passing the user id fails
with `INVALID_OWNER_ID`. Resolve owners through `GET /crm/v3/owners` and match on email — never
assume an id from another HubSpot screen is the one this field wants.

### HubSpot quirks — measured 2026-08-10, portal 23399533

Established by seeding a miniature scenario 2 end to end with `node tools/seed-local.js hubspot`,
then reading every record back. All five cost a round trip.

**1. One bad enumeration value fails the ENTIRE batch.** `industry` has 148 fixed options and
"Logistics" is not one of them — the whole 100-record create returns 400 and nothing lands. This is
the batch-equivalent of LearnUpon's silent 200 and needs the opposite reflex: resolve enum values
against the portal *before* sending. `hsEnumValue_()` reads the option list once and matches on
label or value ignoring case, spaces, ampersands and slashes, so the scenario file can say
`Oil & Energy` and the portal gets `OIL_ENERGY`. An unmatched value is dropped with a note rather
than being allowed to take the batch down.

**2. Batch results are not positional.** A partially successful batch returns fewer results than
inputs, so matching results back by array index silently mis-assigns ids. Every created record
carries `demo_natural_key` and results are matched on that.

**3. `demo_natural_key` is what makes any of this safe.** It is the same stable key the manifest
uses, written as a custom property on companies, contacts, tickets and deals. It gives adoption
after a lost manifest, and it gives Layer 2 something exact to verify before an archive.

**4. The v4 `batch/associate/default` endpoint spares us hard-coded association type ids**, which
differ between portals. Reading associations back shows two entries per pair — a numeric typeId and
`Primary`. That is one association shown twice, not two companies. Verified.

**4a. Enumeration `displayOrder` must be unique across the WHOLE option list.** Merging new options
into an existing property fails with `400 Property option display orders must be unique` if the
incoming options are numbered from 0, as options built from a sheet naturally are. Renumber the
merged list end to end; do not trust either source's numbering. Also, `PATCH` with `options: []` is
a silent no-op — it does not clear a dropdown.

**4b. `POST /crm/v3/objects/{type}/batch/read` SILENTLY IGNORES an `associations` key.** It returns
HTTP 200 with the properties and no associations at all, which made `Verify` report that all six
seeded tickets were unattached when every one of them was correctly linked. This is HubSpot's
version of LearnUpon quirk 3, and it is worse here because it produced a *false alarm* rather than a
false pass — a check that cries wolf gets switched off, which is how a real failure gets through
later. Associations must come from `POST /crm/v4/associations/{from}/{to}/batch/read`
(`hsAssociationsFor_`).

**4c. HubSpot dialogs must name the HubSpot portal.** Every confirmation printed
`environmentLabel()`, which names the **LearnUpon** subdomain — so a HubSpot property write
announced `PORTAL: DEMO (acmetraining.learnupon.com)`. The entire purpose of naming a portal in a
confirmation is to stop a write going to the wrong place, and naming the wrong *system* defeats it.
`hsPortalLabel_()` reports the real portal id and account type, cached once per execution.

**5. Everything scenario 2 needs is settable and verified by read-back:** ticket `createdate`
backdated to any day in a 90-day window, `ticket_category`, `hs_pipeline_stage` by label, priority,
company date properties, deal `closedate` and `amount`. Pipeline and stage IDs are resolved from
labels at seed time, so a scenario file names stages in words.

**Verified refusal.** Two manifest rows were forged to point at real tickets belonging to someone
else. Reset refused both — `no demo_source tag — not ours, refusing to archive` — and left the
ledger rows in place, because a refused delete must not clear the manifest. That is the safety
model working on the one case that matters.

### Refuse, do not fall back — 2026-08-10

Two places resolved a name against the portal and quietly substituted a default when it did not
match. Both have been changed to refuse the whole phase and name the valid options.

| Was | Would have happened |
|---|---|
| Ticket stage falls back to `Closed` | uc1 says `open`, which matches no stage. All 12 tickets filed as Closed, reported `Created: 12, Failed: 0` |
| Deal pipeline falls back to Sales Pipeline | uc1's nine deals name `Onboarding`, which did not exist. $558k of pipeline at "Appointment Scheduled", reported as success |

This is the same failure shape as the completions incident and the stray-enrollment incident: a
green dialog over a wrong dataset. The rule now is that **a name the portal does not recognise stops
the phase**, because a demo built on a silently substituted default is worse than one that did not
seed. Verified by deliberately breaking both and confirming nothing was created.

**The Onboarding deal pipeline was created** in portal 23399533 on 2026-08-10 (id `924734831`):
Kickoff → Data Migration → Training & Enablement → UAT → Go-Live. `setupHubSpotPipelines()` creates
missing pipelines and adds missing stages, and never renames or deletes — deals live on stages, so
removing one would move other people's records somewhere arbitrary.

### Refresh and Verify on the HubSpot side — 2026-08-10

**Refresh re-anchors, it does not shift.** `refreshHubSpotDates()` re-expands the plan against
today's `T` and writes each record to the date the plan gives it, rather than adding N days to what
is there. Two consequences that a blind shift would not have: running it twice is a no-op instead of
pushing everything 2N days out, and HubSpot stays consistent with the LearnUpon side automatically.
Jitter is keyed on the natural key, which does not change, so a ticket keeps its position inside its
window instead of jumping about on every refresh.

This matters most for scenario 2, whose entire story is "last 90 days versus the 90 before". A
ticket seeded at T-88 slides out of the recent window within a week and the 38 → 13 collapse
flattens on its own, with nothing to signal it.

Verified end to end by advancing `T` 45 days: Verify flagged the drift and named the records,
Refresh moved all 8, Verify came back clean, and a second Refresh reported nothing to do.

**Verify reconciles plan → portal**, the direction that can find something. The manifest → portal
check passed cleanly through both previous incidents because it asks the one question whose answer
cannot reveal a missing record. `verifyHubSpot()` checks four things a green seed still gets wrong:
the ticket landed, it is in the stage the scenario asked for, it is associated to a company at all
(so "which account" is answerable), and its date is still inside its declared window.

### Incident — one wrong module id, 188 failed enrollments, 2026-08-10

The first uc2 seed into ACME reported `Seed: courses — Created: 3, Failed: 0` with six lines of
`add_module returned 400` / `publish returned 400` listed underneath as "Problems". The next phase
failed all 188 enrollments with `400 internal error, please try again`, which names nothing.

**Cause, in one line: module ids are portal-specific.** `Scenario1.gs` and `Scenario2.gs` both
hardcoded `7788730`, which exists in `lucidchartsandbox` and not in ACME. uc1's ACME courses use
**`7921958`** — someone had typed the right id into the sheet by hand before the scenario-file
restructure, and Load then overwrote it with the sandbox value.

The chain, each link invisible from the next:

```
add_module 400   ->  course has no content
publish    400   ->  course stays a DRAFT, invisible to GET /courses (quirk 13)
enrollment 400   ->  "internal error" — spike 4: a course with no modules cannot be enrolled on
```

**The defect that made it expensive** was not the wrong id — that is an ordinary data mistake. It
was that `phaseCourses_` counted a course as *created* when `add_module` and `publish` had both
failed. An empty draft is not a course; nothing can ever be enrolled on it. Reporting three
successes and burying the cause in a "Problems" list sent the next phase into a wall with no path
back to the real fault. **Third time this exact shape has shipped**, after the completions incident
and the stray-enrollment incident.

**Fixes:**
- `add_module` or `publish` failing now **throws**, so the course is counted failed and the response
  body is in the message.
- The phase **validates every module id against the portal before creating anything**, one call, and
  refuses with the id, the portal name and what to do. It also refuses an `ilt session` module,
  which spike 4 showed fails every enrollment with "course capacity reached".
- **`Settings.default_source_module_id`** is the portable answer: when a scenario file's id is not
  valid in the current portal, the seeder falls back to this and says so in the preview. One
  scenario file can then seed both portals.
- **`Developer -> Repair Courses`** fixes courses already in this state. Nothing else could: the
  manifest has them, so every phase skips them, while the portal holds an unusable draft. It detects
  drafts through quirk 13 (`GET /courses` returns published only), adds content, publishes, and
  **verifies by reading back** — a course still draft afterwards is named explicitly.

### Incident — the seeder leaked 18 tickets into a shared portal, 2026-08-10

Building the HubSpot side left **18 duplicate tickets and 2 duplicate deals** in portal 23399533:
three copies of every probe record. Found only because an unrelated 400 sent someone looking at the
`ticket_category` options.

**Cause.** Companies and contacts adopt before creating — by domain and by email. **Tickets and
deals did not.** Their only de-duplication was the `_Manifest` diff, so anything not in the ledger
was created again. The harness writes its ledger to a local JSON file, and that file was deleted
between runs, so each run created a fresh set and orphaned the previous one.

`demo_natural_key` was written onto every record *specifically* to make adoption possible after a
lost manifest, and the comment above it says so. It was never wired up for these two object types.

**Why it matters beyond the harness.** Scenario 2 has 217 tickets. Clear or lose `_Manifest` — a
deleted tab, a bad Repair, a second workbook — re-run the phase, and the portal holds 434. Every
number the demo quotes doubles, `Verify` reconciles plan → portal and finds all 217 it expects, and
nothing anywhere says the word "duplicate".

**Fix.** Both phases now index existing records by `demo_natural_key` and adopt. Verified by seeding,
deleting the ledger outright, and re-running: `adopted 6 existing ticket(s) ... they were not
duplicated`.

**The generalisable rule, now true of every object type on both platforms:** *adopt before you
create, on a key the portal itself carries.* The manifest is the authority for **deletion**. It must
never be the only defence against **duplication**, because it is the thing most likely to be missing.

**Second lesson, about tooling.** The probe workbook used invented category keys (`hsp-gap`), and
`setupHubSpotProperties` merged them into the real shared `ticket_category` dropdown, where they
stayed after the records were gone. Test fixtures that touch shared schema must use real values.

### HubSpot (v3/v4, Bearer)

Batch endpoints 100 per call. **Search API is far stricter (~4 req/sec)** — never build a
search-per-record loop; fetch once and build a local email→ID map. Batch responses can be partially
successful.

## Spikes — run in the throwaway portal, in this order

1. **Can `markcompletes` produce an in-progress enrollment** with a `percentage` and a backdated
   last-activity date? Scenario 1 needs in-progress counts, and Story 3's Marcus Feld is "30%
   through, stalled 22 days". Fallback if not: a manual UI touch for two or three hero personas only.
2. **Is enrollment `created_at` settable** on `POST /enrollments`? Assumed no; confirms the
   due-date-based reframing.
3. **Can a Completed enrollment be deleted?** This is the refresh path. Fallback: delete and
   re-clone the course.
4. **Does cloning course `5128555` four times, renaming and publishing** give four usable courses?
   Does the GUID flow work as documented? Does cloning need polling? `POST /courses/{id}/clone`
   takes `name`, and optionally `description`, `publish` and `include_modules`.
5. **Does a backdated completion surface correctly in MCP reporting** — and does the report expose
   anything that reveals a completion predating its own enrollment?

## Build order

| Phase | Contents | Status |
|---|---|---|
| 0 | This spec | done |
| 1 | `Menu` `Config` `Schema` — workbook, credentials. No API calls | done |
| 2 | `Dates` `Random` `Expand` `Validate` `Scenario1` `Tests` — plan is fully inspectable | done |
| 3 | Spikes 1–5 in the throwaway portal | done — see Spike results |
| 4a | `LearnUpon.gs` client + read-only checks (custom fields, clone source) | done |
| 3b | Manual-touch list for in-progress; course strategy in code | done |
| 4b | Users, groups, memberships | done |
| 5 | Courses: create + add_module + publish (NOT clone) | done |
| 6 | Enrollments, due dates, completions | done |
| 7 | `Reset.gs` + `Verify.gs` | done |
| 8 | `Refresh.gs` — safe path and rebuild path | done |
| 9 | `HubSpot.gs` client + properties, `HubSpotSeed.gs` companies/contacts/tickets/deals + reset | done |
| 10 | Scenario 2 data — five accounts of its own, 230 tickets, the deflection curve | done |

**Build reset and verify before running a large seed.** Being able to clean up is more urgent than
being able to create at scale, and it is the natural instinct to get backwards. Test reset against a
five-record seed before a full one.

## Definition of done

- `Create / Repair Workbook` builds the workbook from empty; re-running is harmless
- A teammate with no script knowledge can author the tabs using dropdowns and typed offsets
- `Validate` catches every listed error class and blocks seeding
- `Preview` shows an accurate plan, including headline percentages, without touching a platform
- Each seed phase completes well under 6 minutes
- Two runs with identical sheet contents produce identical records
- `Reset` removes enrollments while leaving users, groups, memberships and courses intact, confirmed
  by `Verify`
- Re-seeding after a reset produces an equivalent dataset with fresh dates
- No code path can delete a user, group, course, or any untagged or unmanifested record

## Open items for Michael

- Create the same two String custom user data fields in **ACME** — the test portal already has
  `Job Title` (id 118987) and `demo_source` (id 118988), both type 1, confirmed 2026-08-05
- Build the "New Customer Enablement" Learning Journey by hand in the UI (realism only; no data
  depends on it)

Resolved 2026-08-05: clone source course is **`5128555`**; the test portal is
**`lucidchartsandbox.learnupon.com`**.

**Clone GUID:** LearnUpon returns a GUID when a course has already been cloned, and it comes back on
what looks like an error response rather than a success. `luRequest_` therefore supports an
`opts.raw` mode that returns the body of a 4xx instead of throwing — the clone code will need it to
read that GUID and reuse it. Confirm the exact shape in spike 4.

## Spike results — 2026-08-05, `lucidchartsandbox`

All five spikes are resolved. Three of them overturned a design assumption, so read this before
`Build order`.

| # | Question | Answer |
|---|---|---|
| 1a | Backdated completion via `markcompletes`? | **Yes.** Asked for 2026-07-07, got 2026-07-07 |
| 1b | Fabricate an *in-progress* enrollment? | **No.** Every route fails |
| 2 | Is enrollment `created_at` settable? | **No.** Silently ignored |
| 3 | Can a Completed enrollment be deleted? | **YES — corrected 2026-08-06.** `remove_from_history` must be the STRING `"true"` |
| 4 | Clone a course, rename, publish? | **Clone is the wrong tool — create the course instead** |

### Spike 4 — build courses, do not clone them

`POST /courses/clone` works, is async (~10s, not the documented 5 minutes), and returns a `guid`
rather than a course id. Cloning the same source again requires `?guid=` in the query string, and
that reminder arrives as an HTTP 400. But the clone is named `<source> - Copy`, and the demo needs
exact titles.

**`POST /courses` is strictly better:** it sets `name` and `reference_code` — our invisible tag — in
one synchronous call. Then `POST /courses/add_module` attaches real content from a source course, and
`POST /courses/publish` publishes it. Verified end to end: a course came out titled
`Getting Started with ACME`, ref `MCPDEMO-NCE-GETTING-STARTED`, 2 modules, published.

So `Courses.clone_source_course_id` becomes a *module donor*, not a clone source.

**Module type decides whether the course can be enrolled on**, tested one type at a time:

| `component_type` | Enrollment | Notes |
|---|---|---|
| `scorm` | **works** | The realistic choice — use this |
| `e signature` | works | |
| `ilt session` | `400 course capacity reached` | Live sessions carry their own seat count |
| `assignment` | `400 internal error` | |
| `exam` | `400 internal error` | |
| *(no modules)* | `400 internal error` | A course must have content |

The first failure was misdiagnosed as SCORM's fault because the course held a SCORM module *and* an
ILT session. SCORM alone enrolls fine. **The rule is: never attach an `ilt session` module.** Note
that ILT modules share one module id across sessions, so the same id can appear twice in a course's
module list.

### Spike 1b — in-progress enrollments cannot be fabricated

`markcompletes` accepts only `completed`, `passed`, `failed` — confirmed empirically as well as in
the docs. `status: in_progress`, `started`, numeric `2`, and percentage-without-status all return
`400 failed to process the completion`. `PATCH /enrollments/{id}` with a status or percentage returns
**HTTP 200 `{"success":"ok"}` and changes nothing.**

**Consequence:** the demo has two achievable states, `completed` and `not_started`. "30% through and
stalled 22 days" is not reachable through the API. Options, in order of preference:

1. Reduce in-progress to the two or three hero personas and have a human open those courses in the
   UI once. Marcus Feld survives; filler in-progress becomes not-started.
2. Drop in-progress entirely and lean on overdue-and-never-started, which is the sharper finding.

Either way the expander must emit a **manual touch list** rather than silently producing enrollments
that look in-progress in the plan and are not-started in the portal.

### Spike 3 — CORRECTED. Completed enrollments are deletable

**The original conclusion was wrong, and it was wrong because of a type.** `remove_from_history` must
be the **string** `"true"`. The spike only ever sent the boolean `true`, which LearnUpon rejects with
`400 invalid deletion request, failed to find the enrollment` — an error message that says nothing
about the flag and reads like the endpoint refusing the record. Michael deleted one by hand from
ACME with the string and reported it.

Re-verified on ACME 2026-08-06 against a real seeded completion:

```
DELETE /enrollments/336940099   body {"remove_from_history":"true"}   ->  HTTP 200, deleted
POST /enrollments + POST /markcompletes  ->  restored to its exact original date
```

So the delete/recreate cycle works end to end, and **the `permanent` object class does not exist.**

Two things from the original spike remain true and still matter:
- Deleting a *course* does not take its completed enrollments with it. They survive as orphans naming
  a course that no longer exists. Delete enrollments directly.
- A rebuild changes the enrollment id, so `_Manifest` must be updated. `manifestUpdateIds()` does it
  in one pass, and `Developer → Repair Manifest` corrects stale ids it finds.

**What this changed:**

- **Reset genuinely resets.** All enrollments, completed or not.
- **Refresh gained a second path.** `Refresh → Rebuild Enrollments` deletes and recreates so
  completion dates move. Needed for the established cohort, whose completions are anchored to their
  own onboarding start and therefore drift as `T` advances.
- **Seeding is recoverable.** A wrong completion is no longer forever, which lowers the stakes on
  every ACME write. `Preview` is still worth running; it is no longer the last line of defence.

**Process note worth keeping.** A single wrong type in one spike produced: an invented object class, a
refresh design missing half its capability, a documented "no teardown" decision, and several
paragraphs of confident prose about permanence. The spike verified the *behaviour* but never varied
the *encoding*, and the error message actively pointed away from the cause. Where a flag is
load-bearing, try both types before concluding it does not work.

## Incident — the first full seed, 2026-08-06

Worth keeping, because the failure mode is the one this project is most likely to repeat.

A full-volume seed into the test portal reported four green phases. It was wrong: **7 completions
landed instead of 192**, so overdue went from a planned 24 to 197 and Alderfield would have shown
about 4% instead of 25%. `Verify` said *"Everything the manifest records is still present."*

The trigger was operator pacing — phases were started before the previous one finished, and the
interleaved dialogs prove it. But three code defects turned a scheduling accident into a silent one:

1. **`phaseCompletions_.build` dropped work with a bare `return`.** Any completed enrollment whose
   enrollment row was not yet in the manifest was skipped with no count and no warning, so the phase
   reported "Created: 7, Failed: 0, No errors".
2. **The script lock was held across the confirmation dialog**, so it serialised nothing useful, and
   two executions appending to `_Manifest` raced on `getLastRow()` — losing 2 enrollment rows and
   2 completion rows.
3. **`Verify` compared the manifest to the portal and never compared the portal to the plan.** It
   checked the only relationship that could not reveal the problem.

Fixes: phases refuse to run when prerequisites are missing and name what is blocked; the lock covers
execution only, with a 120s wait so a queued phase queues instead of racing; `Verify` reconciles
plan → portal per course and per account and prints the percentage the demo will actually show;
`Developer → Repair Manifest` adopts portal enrollments that are missing from the ledger.

**Operating rule that follows: run one phase at a time and wait for its completion dialog.** The
tooling now survives being rushed, but nothing about a 700-call seed rewards impatience.

## API quirks — measured, not assumed

Established against `lucidchartsandbox` on 2026-08-05 with `tools/probe-api.js`. Each of these cost
a debugging round trip; none are in the published docs.

**1. Never send `Content-Type` on a bodyless GET.** LearnUpon tries to parse the empty body and
returns `400 {"error":"There was a problem in the JSON you submitted."}`. `luRequest_` only sets a
content type when there is a payload.

**2. `GET /courses/{id}` does not exist** — it 404s, even for a course that demonstrably exists. The
docs imply otherwise. Use `GET /courses?course_id={id}`, which returns a one-element list.

**3. Unrecognised query parameters are silently ignored, and the endpoint returns everything.**
`?course_id=` filters correctly; `?id=` and `?reference_code=` are ignored and return all 39 courses
with HTTP 200. **This is a safety issue, not a curiosity.** Any "fetch the records matching our tag,
then delete them" logic would match the entire portal. It is a concrete reason the manifest is the
only authority for deletion, and why every filtered read must verify that the record returned is the
record requested.

**4. Rate-limit headers are sent on 2xx only.** `x-lu-rate-limit-remaining-minute` and
`-week` are present on success and absent on 4xx, which is why a failing run reports "n/a". The
sandbox showed 300/minute and 500,000/week. The weekly-floor guard treats null as "unknown" and keeps
going, so the hard per-run call cap is the real backstop.

**5. `GET /users` embeds `CustomData` keyed by field label**, and also returns the field definitions
under a misspelled key, `customDataFieldDefintions`. `GET /users/customuserdata` spells it correctly.
Do not key off either spelling — take the first array in the body.

**6. POST bodies are wrapped in a capitalised resource object; PATCH bodies are not.**

| Call | Body |
|---|---|
| `POST /users` | `{"User": {...}}` |
| `POST /courses` | `{"Course": {...}}` |
| `PUT /courses/{id}` | `{"Course": {...}}` |
| `POST /enrollments` | `{"Enrollment": {...}}` |
| `POST /markcompletes` | `{"Markcomplete": {...}}` — lowercase `c` |
| `POST /groups` | `{"Group": {...}}` |
| `POST /group_memberships` | `{"GroupMembership": {...}}` |
| `PATCH /enrollments/{id}` | **unwrapped** — `{"due_date": "..."}` |
| `DELETE /enrollments/{id}` | **unwrapped**, and `remove_from_history` must be the STRING `"true"` |

An unwrapped POST returns `404 Invalid user parameters provided`. A *wrapped* PATCH returns
`200 {"success":"ok"}` and silently does nothing. That asymmetry cost an hour; it is why the client
must verify writes by reading back, not by trusting a status code.

**7. `markcompletes` rejects `percentage` when status is `completed`** —
`invalid request, percentage: should not be present for completed status`. Percentage is a *score*,
only valid with `passed` or `failed`.

**7b. Booleans are not reliably coerced.** `remove_from_history: true` is rejected;
`remove_from_history: "true"` works. Assume string when a flag misbehaves — and note the error
message names the record, not the parameter, so it misdirects.

**8. Silent 200s are this API's defining hazard.** Three separate confirmed cases: `PATCH` with a
wrapped body, `PATCH` of a status or percentage, and `DELETE` of a completed enrollment. All return
success and do nothing. **Never treat 2xx as proof a write happened — read it back.**

**9. `GET /users/{id}` works; `GET /courses/{id}` does not.** Nested paths are supported per
resource, not globally, so test each one rather than generalising from the last.

**10. There is no `user_id` search parameter.** `GET /users/search` accepts `email` and `username`
only; `?user_id=` is silently ignored and returns the whole roster — see quirk 3. To fetch a user by
id, use `GET /users/{id}`.

**11. `GET /users` and `GET /users/{id}` return `customDataFieldDefintions` BEFORE the user data.**
Taking "the first array in the body" therefore yields field definitions, not users. `firstArrayIn_`
takes a `prefer` list of key names for exactly this reason.

**12. The `num_enrolled` / `num_completed` counters on a course record are stale.** They read 0 for
courses with 127 real enrollments. Count via `GET /enrollments/search?course_id=` and nothing else.

**13. `GET /courses` returns published courses only.** A course cloned with
`publish_after_clone: false` never appears, and no `status` / `state` / `include_drafts` parameter
surfaces it. Draft courses created by the API are invisible to the API that created them.

## Incident — the invariant broke on the first ACME seed, 2026-08-06

The seed was correct by every measure the toolkit had. `Verify` reported the portal matching the plan
and all nine percentages exact. Then a demo question run through the MCP returned **15.9%** for
Alderfield instead of 25%.

**ACME auto-enrols every new user in "An Introduction to LearnUpon"** (course `3038648`, no reference
code, not ours). All 127 seeded users picked it up as a side effect of being created. Alderfield went
from 28 enrollments to 44, so 7 completions read as 15.9% rather than 25%.

This is the exact invariant recorded at the top of this document — *never enroll a seeded user in a
course outside their use case's required set* — and nothing enforced it.

**Why `Verify` passed.** It reconciled the courses *in the plan* against the portal, per course and
per account. It never asked the reverse question: do our users hold enrollments we did not create?
The check that could not fail was the one being run. That is the second time this exact shape of
mistake has shipped, after the completions incident.

**Fixes:**
- `reconcilePlanToPortal_` scans every manifest user's enrollments and flags any course that is not
  ours. `Verify` now prints three numbers per account — intended, our-courses-only, and **as the demo
  sees it** — and shouts `DILUTED by N stray enrollment(s)` when they diverge.
- `Developer → Remove Stray Enrollments` deletes them, skipping anything completed and verifying each
  delete by read-back.
- The portal-side auto-enrolment must be turned off, or the next seed recreates all 127.

**The deliberate exception this creates.** Removing strays deletes records the manifest does not
list, which contradicts Layer 1. The substituted authority is stated in the code and in the
confirmation dialog: *the enrollment belongs to a user we created, and the course is not ours.* It
lives behind its own menu item, never runs as part of Reset, and refuses to touch a completion.

**Generalisation worth keeping:** a portal can attach records to our objects without us asking.
Auto-enrolment rules, dynamic group rules, certification renewals, onboarding workflows. Any
reconciliation that only walks outward from the plan will miss all of them.

## The seeder and the MCP can point at different portals

**Superseded — this was my error, not a real mismatch.** The MCP connector available in that session
pointed at a different portal than the ACME connector Michael uses; once the ACME connector was
attached, all nine groups, the four courses and the 127 users were present. Kept because the Step 0
preflight it produced is still worth running: confirm the assistant can see the seeded groups before
grading any demo answer.

The original note follows. **The seed into
`acmetraining.learnupon.com` was correct and fully reconciled — 127 users, 4 courses, 223
enrollments, 192 completions, every account percentage exact. And the MCP server could not see a
single record of it:

| Query through the MCP | Result |
|---|---|
| groups matching `Customer: Alderfield` | none |
| groups matching `Customer` | only `Customer: ACME` (id 8629), which predates us |
| course `Getting Started with ACME` | not found |
| users at `alderfield-financial.com` | none |
| custom user data definitions | the same 27 as on day one, with `* Job Title *` (type 4) and **no** `Job Title` / `demo_source` |

That last row is conclusive: `Setup → Check Custom Fields` passed against `acmetraining` before the
seed, so those two String fields exist there — and they do not exist in the portal the MCP reads.
Two different portals. Possibly a sub-portal relationship, since this API has `clone_to_portal_id`.

**The structural lesson: `Verify` cannot catch this.** It proves the portal the seeder *writes to*
matches the plan. It has no visibility into the MCP's configuration, so it cannot tell you the demo
is reading somewhere else. Nothing in this toolkit can. The only defence is a preflight question put
to the assistant itself — now Step 0 of `docs/mcp-validation.md`.

Cost asymmetry worth remembering: re-pointing the MCP is free, whereas seeding a second portal is a
700-call write. Less irreversible than it looked at the time — completions turned out to be
deletable — but still not free.

## What the reporting layer exposes — measured 2026-08-06

Read through the MCP connector against the seeded ACME data, which is the only view that matters for
the demo.

**`created_at` betrays the backdating.** A completed enrollment reads *enrolled 08/06/2026, completed
06/13/2026, due 07/18/2026* — finished two months before it was created. Enrollment `created_at` is
not settable (spike 2) and completions are backdated, so this is structural and unfixable. For the
established cohort the gap is 300+ days.

`date_started` mirrors `date_completed`, so those two agree; only `created_at` is anomalous. Nothing
in Story 1 or Story 3 needs it — they read status, due date and completion date. **The prompt library
must therefore pin the columns each demo report requests and omit `created_at`.** An unconstrained
"show me the enrollment details" will surface it.

**The job title field works.** `ud_118989` (String) returns real titles, so "which of these people
are administrators?" is answerable. Alderfield's fourth admin is a generated learner, Kiera Vasquez
(IT Administrator) — the narrative line "risk concentrates in three people" should say four.

**Reporting quirks:** `row_count` is 0 even when `enrolment_total` is 44, so a model quoting the
summary verbatim can report zero rows; `due_date_passed` returns the strings `"yes_string"` /
`"no_string"` rather than booleans; course names carry a ` v.1` version suffix; dates come back
`MM/DD/YYYY`.

## A guard that failed silently — 2026-08-10

`uiConfirmTyped` returned `false` with **no dialog** when the typed text did not match. Every write
phase against the demo portal needs `SEED DEMO` typed exactly, so one trailing space made a phase
disappear without a word. The operator reasonably concluded it had run, moved on to the next phase,
and hit a blocking error two steps later that named a completely different cause.

Cancelling stays silent — that is a deliberate choice and needs no explanation. A **mismatch** now
says so explicitly, states that nothing was created or deleted, and tells you what to type. Matching
is case- and space-insensitive: the safety is in typing the words deliberately, not the capitals.

**The general rule this belongs to:** a safety check that declines to act must say it declined.
Silence is read as success, and every hour of the resulting confusion is spent looking somewhere
else. This is the same failure as counting an empty draft course as created, one layer up.

## Reporting quirk that produced a false all-clear — 2026-08-10

**`is_preview: true` on the MCP progress report silently caps the result set, and the SUMMARY
BLOCK IS COMPUTED ON THE SAMPLE, NOT THE POPULATION.** A report on course `3038648` returned
`enrolment_total: 5` for a course holding **240** enrollments. The number is not labelled as
partial, carries no truncation flag, and looks exactly like a real total.

That answer was used to conclude ACME's auto-enrolment rule had been turned off, and to tell Michael
it was safe to seed. It had not been turned off. 74 more strays were created.

**Rule: never read a total from a preview.** Any count that a decision rests on must be run with
explicit `pagination` and no `is_preview`. Preview is for eyeballing shape, nothing else.

This is the same family as LearnUpon quirk 12 (`num_enrolled` reads 0 for a course with 127
enrollments) and quirk 3 (an ignored filter returns everything): **this stack's reporting layer
returns confident, well-formed, wrong numbers**, and the only defence is to check totals two ways
before acting on them.

## Sheets quirks

**Checkbox validation materialises `FALSE` into every blank cell in its range.** `is_admin` and
`is_deliberate_gap` are checkbox columns applied down to row 201, so after `Create / Repair Workbook`
runs, ~190 untouched rows on People and TicketCategories stop being empty. `tabRows` therefore treats
`false` as blank alongside `''` and `null`; every genuine row carries a key, so nothing is lost.

Ordering hid this for a long time: `Load Example Scenario` calls `clearContent()`, so
load-then-validate was clean and only repair-after-load exposed it. `tools/verify-local.js` cannot
catch this class of bug at all — it stubs `tabRows` and so never sees what the sheet actually stores.
That is the standing limitation of the local harness.

## Sources

- LearnUpon API guide — https://docs.learnupon.com/api/
- HubSpot object APIs — https://developers.hubspot.com/docs/guides/crm/using-object-apis
- Apps Script quotas — https://developers.google.com/apps-script/guides/services/quotas
