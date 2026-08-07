# Working together — three scenarios, one workbook, one portal

For Nik, Michael and Brian. You don't need to read any code to own a scenario.

**New here?** Start with [getting-started.md](getting-started.md) — GitHub account, cloning the
repo, and the prompts to use with Claude Code. Come back to this once you have it running.

## Use your own menu

Each scenario has its own submenu, titled with its name and owner:

```
MCP Demo Seeder ▸ Scenario 2 — Knowledge Gaps (Michael) ▸ …
```

Everything inside it acts on that scenario only. You don't set anything first — the menu carries the
scope. Destructive actions make you type it out (`RESET UC2`), so you can't wipe a colleague's data
by clicking through a dialog.

**If you're in someone else's submenu, you're about to change their data.** That's the only mistake
this setup really lets you make.

## Your five steps

1. **Edit your scenario file** — `apps-script/Scenario2.gs`. Claude Code is the expected way to do
   this. It's data only: arrays of rows, one per account, person, course, enrollment.
2. **Check it locally**: `node tools/verify-local.js uc2`. Prints your per-account percentages,
   overdue counts and validation without touching the sheet or the portal. Iterate here — it's
   seconds per cycle rather than minutes.
3. **Paste the file** into the Apps Script editor (Extensions ▸ Apps Script, pick `Scenario2`,
   replace the contents, save).
4. **Load Sheet Data** from your scenario's submenu. This replaces your rows in the sheet and
   validates immediately. It leaves the other two scenarios alone.
5. **Preview → Refresh → Verify.** Preview writes the whole plan to `_Preview` without touching a
   portal. Refresh makes the portal match. Verify checks that it did.

### The three verbs

| | |
|---|---|
| **Refresh — add & update** | Creates what's missing, updates due dates that have drifted. The everyday action. Nothing is deleted. Run it after every Load. |
| **Rebuild Enrollments** | Deletes and recreates enrollments so **completion dates** move. Destructive — only when a completion date needs to change. |
| **Reset** | Deletes your scenario's enrollments. Destructive. |

**Refresh is idempotent and re-runnable.** Run it twice and the second run says *"nothing to do"*. If
there's more work than one execution can do, it stops at the API call cap and tells you how many
records remain — just run it again until it reports nothing left. That's how a 700-call first seed
gets done without ever hitting the six-minute execution limit.

Refresh will not silently ignore what it can't fix. If your file changed a completion date, or you
reduced an account from 16 learners to 12, it says so and names the action that would handle it.

*"Seed step by step"* does the same work in four bounded phases. Useful for a first seed when you
want to watch each stage land; unnecessary otherwise.

### Load vs Refresh

- **Load** = scenario file → the spreadsheet. Free, reversible, no portal involved.
- **Refresh** = the spreadsheet → LearnUpon and HubSpot. This is the one that writes to a shared portal.

You can hand-edit the sheet, and those edits stick — right up until the next **Load**, which
replaces your rows with whatever the file says. If you want a change to last, put it in the file.

### What happens if you Refresh twice?

Nothing the second time. Every record is matched by a stable key against `_Manifest`, so re-running
creates no duplicates. Safe to run whenever you're unsure.

### Two rules for editing the file

1. **Row width must match exactly.** Columns are listed in a comment above each builder, and
   `Developer ▸ Show Column Contract` prints them. Load refuses rows of the wrong width rather than
   letting the values shift one place and look almost right.
2. **Prefix your globals** — `UC2_CSM_OWNER`, `scenario2Accounts_`. All the `.gs` files compile as
   one unit, so if two scenario files declare the same `const` name, nothing runs for anyone until
   it's fixed.

## Who owns what

| | |
|---|---|
| **You own** | `ScenarioN.gs` · your rows in every tab · your narrative and numbers · your expected numbers · your validation prompts · Load, Preview, Seed, Verify, Refresh and Reset for your scenario |
| **Michael owns** | The shared `.gs` files (everything except the scenario files) · credentials · resolving conflicts between scenarios |
| **Shared, change only by agreement** | `Settings` · the course catalogue · the ticket category taxonomy · the deliberate content gaps |

You paste your own scenario file. You don't paste the shared ones — if `Expand.gs` or `Validate.gs`
needs to change, ask Michael, because a half-pasted core file breaks all three scenarios at once.

Worth knowing where the difficulty actually is: every problem this project has hit has been a
**data-model** problem, not a coding one. A stray course diluting every percentage. A completion date
landing after the ticket decline it was meant to cause. A report column quietly exposing backdated
data. That's the work, and it's yours.

## Declare your expected numbers

Each scenario file has a `scenarioNExpected()` function. Fill it in **before** you seed — account by
account, the percentage the demo should show:

```javascript
function scenario2Expected() {
  return {
    accounts: {
      northwind: { completion: 28, note: 'top target — high tickets, low training' },
      cobaltpeak: { completion: 92, note: 'contrast — fully trained, quiet' }
    },
    notes: ['Integrations tickets should fall 38 -> 13 quarter over quarter']
  };
}
```

**Verify** prints these next to what the portal actually holds and flags anything off by more than
two points. Nothing is blocked by it — it's there so drift is visible without anyone having to
remember the intent three weeks later.

Writing them first is the habit that matters. Scenario 1's Alderfield was supposed to show 25% and
showed 15.9%, and the gap turned out to be a course the portal was auto-enrolling everyone into that
nobody had noticed.

## Things that are global, and will collide

One LearnUpon portal and one HubSpot portal hold all three scenarios. So some things can only exist
once, and validation will refuse duplicates:

| Global thing | Why it collides |
|---|---|
| **Company names** | Each becomes a LearnUpon group `Customer: <company>`. Two groups with one title makes it impossible to tell which account a learner belongs to — and both scenarios' percentages become meaningless. |
| **Email domains** | Learner emails are `first.last@domain`. Two accounts on one domain collide on email, and email is the join key between LearnUpon and HubSpot. |
| **Course titles** | One catalogue. If two scenarios need the same course, share it — the group filter keeps your percentages separate. |
| **Ticket categories** | One taxonomy across all three scenarios. |
| **The deliberate gaps** | Data Import & Migration, Certification & Compliance and Billing & Subscription must have **no course**. Scenario 2's entire Story 1 is "these categories have no training". If you add one of these courses for your scenario, you break Michael's. Validation blocks it. |

If validation refuses a duplicate, it isn't being fussy — it's telling you two scenarios have made
incompatible claims about the same object. Talk to the other owner; Michael arbitrates.

## The invariant nobody may break

**A seeded user must never be enrolled in a course outside their own scenario's required set.**

The demo computes "percent of required training complete" from a group-filtered report — so every
enrollment a group holds counts toward the denominator. One extra course silently changes every
percentage in that scenario.

This has already happened once, portal-side, and it took the demo from 25% to 15.9% without a single
error message. `Verify` now checks for it and reports `DILUTED by N stray enrollment(s)`.

## Constraints you'll run into

Not bugs — measured limits of the LearnUpon API. Design around them rather than fighting them:

- **In-progress enrollments cannot be created.** Only `completed` and `not started`. If your story
  needs "40% through and stalled", that's a manual click in the portal UI per person, and Preview
  lists them under `MANUAL STEP`. Keep the number small.
- **Enrollment "assigned date" is always today.** It isn't settable. Anything resting on "assigned 47
  days ago" has to be re-framed around **due dates**, which are settable and refreshable.
- **Completion dates are settable**, so any story about *when* something was completed works fine.
- **Users are never deleted** by this toolkit. Everything else can be removed.

## Changing a shared file

Scenario files are yours. Everything else — `Expand.gs`, `Validate.gs`, `Seed.gs`, `Menu.gs` and the
rest — is shared, and there is one thing about it that makes the process matter:

**There is a single Apps Script project behind this workbook.** The moment you paste a shared file,
it is live for all three of us. There is no staging, no review step, and no version history in the
editor. Nik pasting `Validate.gs` changes the tool Brian is using, mid-session.

So if you need to change one:

1. **Make the change in the repo**, not just in the editor.
2. **Run `node tools/verify-local.js uc1`, `uc2` and `uc3`.** Shared files affect all three
   scenarios; check you have not broken someone else's.
3. **Bump `TOOLKIT_VERSION`** in `apps-script/Version.gs`, with a one-line note.
4. **Commit and push**, with a message saying what changed and why:
   ```
   git add -A
   git commit -m "Validate: catch duplicate company names across scenarios

   Company names become LearnUpon group titles, so two scenarios claiming
   the same one makes both completion percentages meaningless."
   git push
   ```
5. **Paste the changed files** into the editor, including `Version.gs`.
6. **Post in Slack**, so nobody discovers the change by having something break:

   ```
   🔧 Seeder update — v1.0.1
   Changed:  Validate.gs, Version.gs
   Why:      duplicate company names across scenarios weren't caught
   Impact:   everyone — re-run Validate, you may see new errors
   Pasted:   yes, live now
   Commit:   abc1234
   ```

The **Impact** and **Pasted** lines are the ones that matter. "Pasted: yes" means it is already
running for all of us. If you push without pasting, say so — otherwise the next person to hit a bug
will be debugging code that is in git but not in the sheet.

### Checking whether you are in sync

**Developer ▸ About / Version** shows what is installed. Compare with:

```bash
git log --oneline -1
grep TOOLKIT_VERSION apps-script/Version.gs
```

If those disagree, stop and ask in Slack. You may be looking at code nobody else is running.

### What to change yourself, and what to hand over

| | |
|---|---|
| Change it yourself | Your scenario file. Anything wrong with a validation *message*. A comment that misled you. |
| Say something first | New columns or tabs, anything touching `Manifest.gs`, `Seed.gs`, `Reset.gs` or `Refresh.gs`, anything that changes what gets written to a portal |

The second list is not about permission — it is that those files carry the safety rules (manifest-only
deletion, verify-after-write, scope filtering) and the reasons are in `CLAUDE.md` rather than in the
code. Read that first and the change will be easier anyway.

## When to ask Michael

- You need a new column, a new tab, or a new kind of generated record
- Validation reports something you don't understand — the message is probably wrong, tell him
- The portal returns an error the toolkit didn't anticipate (this API has a habit of returning
  `200 OK` while doing nothing, so if a write "succeeded" but nothing changed, that's a real finding)
- You need to seed a scenario other than your own

## Reference

- `docs/getting-started.md` — setup, and prompts for Claude Code
- `CLAUDE.md` — the full spec, including every API constraint we've measured and why
- `docs/mcp-validation.md` — how to test a seeded scenario against the MCP
- `INSTALL.md` — how the workbook and script are set up
