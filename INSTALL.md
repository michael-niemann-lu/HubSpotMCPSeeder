# Install — no clasp required

Eighteen files, pasted once. About ten minutes.

## 1. Create the sheet

1. Go to [sheets.new](https://sheets.new) and name it something like **MCP Demo Data Seeder**
2. **Extensions → Apps Script**. This creates a container-bound script project, which is what we want
3. Rename the project (top left) to `MCP Demo Seeder`

## 2. Paste the files

The editor starts with one file called `Code.gs`. For each file below: click **+ → Script** in the
Files panel, type the name **without the `.gs`** (the editor adds it), then paste the whole contents
of the matching file from `apps-script/`.

Paste in this order. Nothing breaks if you don't — Apps Script hoists everything — but this order
means you can save and sanity-check as you go.

| # | Create a file named | Paste from |
|---|---|---|
| 1 | `Schema` | `apps-script/Schema.gs` |
| 2 | `Config` | `apps-script/Config.gs` |
| 3 | `Dates` | `apps-script/Dates.gs` |
| 4 | `Random` | `apps-script/Random.gs` |
| 5 | `Expand` | `apps-script/Expand.gs` |
| 6 | `Validate` | `apps-script/Validate.gs` |
| 7 | `ScenarioLoader` | `apps-script/ScenarioLoader.gs` |
| 7a | `Scenario1` | `apps-script/Scenario1.gs` |
| 7b | `Scenario2` | `apps-script/Scenario2.gs` |
| 7c | `Scenario3` | `apps-script/Scenario3.gs` |
| 8 | `Tests` | `apps-script/Tests.gs` |
| 9 | `LearnUpon` | `apps-script/LearnUpon.gs` |
| 10 | `Manifest` | `apps-script/Manifest.gs` |
| 11 | `Seed` | `apps-script/Seed.gs` |
| 12 | `Reset` | `apps-script/Reset.gs` |
| 13 | `Refresh` | `apps-script/Refresh.gs` |
| 14 | `HubSpot` | `apps-script/HubSpot.gs` |
| 15 | `HubSpotSeed` | `apps-script/HubSpotSeed.gs` |
| 16 | `Version` | `apps-script/Version.gs` |
| 17 | `Menu` | `apps-script/Menu.gs` |

Then **delete the starter `Code.gs`** (three-dot menu next to it → Remove). Its empty `myFunction`
does nothing but it will clutter the run dropdown.

### The manifest

Click the gear icon (**Project Settings**) and tick **Show "appsscript.json" manifest file in
editor**. Open the `appsscript.json` that appears and replace its contents with
`apps-script/appsscript.json`. This pins the V8 runtime and sets the script timezone to UTC, which
matters because all our date arithmetic is UTC.

Save everything (⌘S).

## 3. First run

1. Reload the spreadsheet tab. An **MCP Demo Seeder** menu appears
2. **MCP Demo Seeder → Setup → Create / Repair Workbook**
   - Google will ask you to authorize the script the first time. It is your own script, so the
     "unverified app" warning is expected: **Advanced → Go to MCP Demo Seeder (unsafe)**
   - It needs Sheets access (to build the workbook) and external requests (to reach the LearnUpon API)
3. When it finishes you should have a README tab plus 13 others. Read the README tab — it documents
   the T-scale convention and the safety model in the place people will actually look
4. **Scenario 1 → Load Sheet Data** — writes the worked Customer Onboarding Health dataset
5. **Developer → Run Unit Tests** — expect *All 22 tests passed*
6. **Validate** — expect *Clean — no errors, no warnings*
7. **Preview (dry run)** — writes ~490 rows to `_Preview`. Nothing has touched any platform yet

If step 5 or 6 reports failures at this point, something went wrong in the paste — most likely a
truncated file. Re-paste that file rather than debugging it.

## 4. Credentials — when you're ready

Credentials are per-environment, so the throwaway test portal and ACME can coexist. `Settings.environment`
selects which set is live, and it ships set to `test`.

1. Set `Settings.environment` to `test`
2. **Setup → Set Credentials** — you'll be prompted for the subdomain and the API key pair. Leave the
   HubSpot prompt blank for now. Values go to Script Properties, never into a cell
3. **Setup → Check Credentials** — reports whether the key pair authenticated, and your remaining
   rate-limit budget for the minute and the week. It never prints a secret
4. **Setup → Check Custom Fields** — lists the portal's custom user data fields and confirms the two
   we need exist and are String (free text) type
5. Set **`Settings.course_owner_id`** to a portal admin's LearnUpon user id. `POST /courses` requires
   an owner, and it must be a user in *this* portal
6. **Setup → Check Course Source** — confirms the module id on the Courses tab exists here and is a
   type you can actually enroll on. An `ilt session` module makes every enrollment fail

All of these are read-only. Nothing is written to a portal until the Seed menu exists.

> LearnUpon API keys live at **Settings → Integrations → API Keys**. Generating new keys breaks
> existing integrations, so check whether a pair already exists before creating one.

Repeat with `environment` set to `demo` when ACME's turn comes.

> Anyone with edit access to the sheet can open the script editor and read Script Properties. That's
> an accepted trade-off for shared demo-portal credentials — it's recorded on the README tab so it
> isn't a surprise later.

## Making changes later

Edit the file here, then re-paste that one file into the editor. That's the whole reason the code is
split into eighteen small files instead of one big one.

Scenario owners paste only their own `ScenarioN.gs`. Everything else is shared, and a half-pasted
shared file breaks all three scenarios at once.

Before you re-paste anything, run the local harness:

```
node tools/verify-local.js
```

It runs `Dates`, `Random`, `Expand`, `Validate` and the example scenario under Node with the Sheets
API stubbed out, then prints the unit tests, the plan summary and the validation results. It cannot
test `Schema` or `Config` — those touch `SpreadsheetApp` and `UrlFetchApp`, so they need a real run
in the editor — but it catches everything else without a round trip.

## Seeding

The Seed submenu is numbered because the phases are ordered — enrollments need courses, completions
need enrollments:

```
Seed ▸ 1. Users, Groups, Memberships
       2. Courses
       3. Enrollments
       4. Completions
Verify
Refresh ▸ Shift Due Dates (safe)
          Rebuild Enrollments (completion dates)
Reset   ▸ Delete Enrollments
```

**Refresh** is how the demo stays current, and it has two paths:

- **Shift Due Dates** — recomputes the plan against today's anchor and moves due dates to match.
  Nothing created, nothing deleted. This restores "due 18 days ago and still not started", which is
  what Story 1's risk board reads. Enough on its own for the three in-flight accounts.
- **Rebuild Enrollments** — deletes and recreates enrollments so **completion dates** move too. The
  established cohort's completions are anchored to their own onboarding start, so they drift as time
  passes. Destructive, typed confirmation, and bounded by the API call cap — it reports how many
  remain and is safe to re-run until none are left.

Run Shift Due Dates before any demo. Run Rebuild when the established cohort's completion dates have
drifted far enough to look wrong.

Each phase validates first and refuses to run while any error exists, diffs the plan against
`_Manifest` so re-running is safe, names the target portal in its confirmation, and appends every
created record to `_Manifest` as it goes. Seeding the `demo` portal requires typing `SEED DEMO`.

**Run `Verify` after any `Reset`.** It confirms every persistent record the manifest lists is still
present. A reset that removed a user is a bug, not a cleanup, and this is what catches it.

## What is not built yet

The HubSpot half: companies, contacts, the three company date properties, the Onboarding pipeline,
deals and tickets. Its spikes are done — ticket `createdate` and deal `closedate` are both settable
on create *and* update, so HubSpot is fully refreshable.

Two things those results changed, which are worth knowing before you seed anything:

- **In-progress enrollments cannot be created through the API.** The example scenario declares three,
  all named personas. Preview lists them under `MANUAL STEP`; open each one in the portal UI by hand
  after seeding. Keep that number small.
- **Completed enrollments ARE deletable**, via `DELETE /enrollments/{id}` with body
  `{"remove_from_history":"true"}` — the string, not the boolean. So Reset genuinely resets, and
  `Refresh → Rebuild Enrollments` can move completion dates. Still worth running Preview first: a
  700-call write into a shared portal deserves a look before you commit.
