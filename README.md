# MCP Demo Data Seeder

Seeds, refreshes and safely removes demo data in **LearnUpon** and **HubSpot**, so an AI assistant
querying them over MCP can answer cross-system questions about training-driven outcomes.

Three scenarios share one workbook and one pair of portals:

| | Scenario | Owner |
|---|---|---|
| `uc1` | Customer Onboarding Health | Nik |
| `uc2` | Knowledge Gaps vs Support Tickets | Michael |
| `uc3` | Upsell and Renewal Readiness | Brian |

---

## If you are Claude Code, read this first

**What this repo is.** A Google Apps Script project (pasted by hand into a container-bound script —
there is no clasp) plus Node tools for local testing. `apps-script/*.gs` are the files that get
pasted; `tools/*.js` never leave the laptop.

**Before changing a shared file.** Scenario files (`Scenario1/2/3.gs`) belong to one owner each and
can change freely. Everything else is shared by three people through a single Apps Script project
with no staging — a paste is live for everyone immediately. Bump `TOOLKIT_VERSION` in `Version.gs`,
run the harness for all three scenarios, and follow the process in `docs/working-together.md`.

**Where the authority is.** `CLAUDE.md` is the working spec and the record of every API constraint
we have measured the hard way. Read it before changing behaviour — most of what looks like an
arbitrary choice is there because a spike proved the obvious approach doesn't work.

**The loop.** After editing anything under `apps-script/`, run:

```bash
node tools/verify-local.js uc1        # or uc2 / uc3
```

It executes the real `Dates`, `Random`, `Expand`, `Validate` and scenario files under Node with the
Sheets API stubbed, then prints the unit tests, the plan summary, per-account percentages and
validation results. **It does not touch the sheet or any portal.** This is the fast feedback loop —
use it before asking anyone to paste a file.

**What it cannot test:** anything touching `SpreadsheetApp`, `UrlFetchApp` or `PropertiesService` —
so `Schema.gs` and `Config.gs` need a real run in the editor. Checkbox coercion, formula-blank
behaviour and date objects are all invisible to the harness. Two real bugs have hidden there.

### Editing a scenario's data

Scenario data lives in `apps-script/Scenario1.gs`, `Scenario2.gs`, `Scenario3.gs`. Each file is data
only: positional arrays plus a five-line loader.

Two rules that will otherwise cost the whole team an outage:

1. **Row width must match the tab spec exactly.** The columns are listed in a comment above each
   builder, and `Developer ▸ Show Column Contract` prints them in the sheet. Load refuses rows of
   the wrong width rather than letting values shift silently.
2. **Prefix every top-level `const` with the use case** (`UC2_CSM_OWNER`) and every function with its
   number (`scenario2Accounts_`). Apps Script compiles all files as one unit, so two files declaring
   the same const is a syntax error that breaks the project for all three scenarios.

### Things that are global across scenarios

One LearnUpon portal, one HubSpot portal. Validation refuses duplicates with an explanation:
company names (they become group titles), email domains (the cross-system join key), course titles
(one catalogue), account keys. The **deliberate content gaps** — Data Import & Migration,
Certification & Compliance, Billing & Subscription — must never get a course; scenario 2's entire
Story 1 is "these categories have no training".

### The invariant

**A seeded user must never be enrolled in a course outside their own scenario's required set.** The
demo computes "percent of required training complete" from a group-filtered report, so one stray
enrollment silently changes every percentage. This has already happened once in production data.

---

## Layout

```
CLAUDE.md                  the working spec — decisions, API constraints, incident write-ups
INSTALL.md                 paste order and first run
README.md                  this file
docs/
  working-together.md      how the three owners share one workbook (start here if you are Nik or Brian)
  mcp-validation.md        how to test a seeded scenario against the MCP
  original-brief.md        superseded first draft, provenance only
apps-script/               the files pasted into the editor
  Schema.gs                setupWorkbook, the tab/column contract, the README tab
  Config.gs                settings, scope, credentials, sheet I/O, locking, logging
  Dates.gs                 the T / S / G offset grammar
  Random.gs                FNV-1a hash, deterministic jitter, filler-learner names
  Expand.gs                declarations -> plan, scoping, preview
  Validate.gs              the hard gate, including cross-scenario collisions
  ScenarioLoader.gs        shared Load machinery for the three scenario files
  Scenario1.gs             uc1 data
  Scenario2.gs             uc2 data
  Scenario3.gs             uc3 data
  Tests.gs                 unit tests
  Manifest.gs              the ledger, and the only authority for deletion
  LearnUpon.gs             HTTP client (pacing, retries, call cap) + read-only setup checks
  Seed.gs                  the four write phases
  Reset.gs                 reset, verify, repair manifest, remove strays
  Refresh.gs               shift due dates (safe) and rebuild enrollments (destructive)
  Menu.gs                  menu wiring and the per-scenario wrappers
  Version.gs               TOOLKIT_VERSION — bump it with any shared-file change
tools/
  verify-local.js          run the pure layers locally — the development loop
  seed-local.js            run the REAL seed/reset/verify against a portal, sheet faked
  probe-api.js             read-only LearnUpon diagnostics
  hubspot-probe.js         read-only HubSpot diagnostics
  spike.js                 API spikes; writes to a portal
```

`apps-script/local/` holds credentials and is gitignored. Never read it into a conversation — the
tools load it themselves and print only status codes.

---

## Menu

```
MCP Demo Seeder
├─ Setup ▸ Create / Repair Workbook │ Credentials │ Check Custom Fields │ Check Course Source │ Find a Module
├─ Scenario 1 — Customer Onboarding Health (Nik) ▸
│    Load Sheet Data from Scenario1.gs
│    Validate │ Preview (dry run)
│    Refresh — add & update          <- the everyday action; idempotent, re-runnable
│    Verify
│    Seed step by step ▸ 1-4 │ Shift Due Dates only
│    Rebuild Enrollments (moves completion dates)   <- destructive
│    Reset — delete this scenario's enrollments      <- destructive
├─ Scenario 2 — … (Michael) ▸ same
├─ Scenario 3 — … (Brian) ▸ same
└─ Developer ▸ Unit Tests │ Column Contract │ Resolved Dates │ API Probe │ Repair Manifest │ Remove Stray Enrollments
```

Every action is scoped to its scenario, so one owner's Reset cannot reach another's data.

---

## Constraints worth knowing before you design data

Measured, not assumed. Full detail in `CLAUDE.md`.

- **In-progress enrollments cannot be created** by the API — only *completed* and *not started*.
  Anything part-way is a manual click in the portal UI. Preview lists them under `MANUAL STEP`.
- **Enrollment "assigned date" is always today.** Not settable. Re-frame anything resting on
  "assigned 47 days ago" around **due dates**, which are settable and refreshable.
- **Completion dates are settable**, and completed enrollments *are* deletable — but only with
  `{"remove_from_history": "true"}` as a **string**. The boolean is rejected.
- **A 2xx does not mean the write happened.** This API returns `200 {"success":"ok"}` for several
  no-ops. Every write is verified by reading it back.
- **Users are never deleted** by this toolkit. Everything else can be removed.

## Seed, Refresh, Reset

- **Refresh** creates what is missing and updates what has drifted. Idempotent — matched against
  `_Manifest` by stable natural key, so running it twice creates nothing the second time. Bounded by
  the API call cap: it reports what remains and is safe to re-run until it says nothing to do.
- It deliberately will **not** move a completion date (that needs delete-and-recreate — use Rebuild)
  or delete records the scenario no longer describes (use Reset). It counts both and says so rather
  than ignoring them.
- **Reset** deletes that scenario's enrollments and the completion ledger rows that belong to them.
