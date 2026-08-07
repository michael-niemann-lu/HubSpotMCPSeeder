# Getting started — for Nik and Brian

You do not need to be a developer to own a scenario. You need a GitHub account, a copy of this
repository on your laptop, and Claude Code. About twenty minutes, most of it downloads.

---

## Before you start — Michael does this

The repository is private, so it won't open until you've been invited.

**Michael:** once they send you their GitHub username, go to
`github.com/michael-niemann-lu/HubSpotMCPSeeder` → **Settings** → **Collaborators** →
**Add people**. Invite `nik-…` and `brian-…` with **Write** access.

---

## Part 1 — one-time setup, about 20 minutes

### 1. Create a GitHub account

Go to [github.com/signup](https://github.com/signup) and sign up **with your LearnUpon email
address**. Pick a username that makes it obvious who you are — `nik-lastname-lu` is ideal.

Then **send Michael your username** so he can give you access. You can't clone until he has.

### 2. Install Node.js

Download the **LTS** version from [nodejs.org](https://nodejs.org) and run the installer. Accept
every default.

This is what runs the local checker — the thing that shows you your scenario's numbers in about two
seconds without touching the sheet or the live portal. It's the single most useful tool here.

### 3. Install GitHub Desktop

Download from [desktop.github.com](https://desktop.github.com). Open it, choose **Sign in to
GitHub.com**, and log in with the account you just made.

You could do this from a terminal instead, but GitHub Desktop handles the login and the download
with buttons, and you'll never have to think about credentials again.

### 4. Get the repository

In GitHub Desktop: **File → Clone repository → GitHub.com**, pick
**HubSpotMCPSeeder**, and note the folder it saves to (usually
`~/Documents/GitHub/HubSpotMCPSeeder`). Click **Clone**.

If it isn't in the list, Michael hasn't added you yet.

### 5. Open it in Claude Code

Open a terminal and run:

```bash
cd ~/Documents/GitHub/HubSpotMCPSeeder
claude
```

That's it. Everything else you can ask for.

---

## Part 2 — prompts to use

Copy these into Claude Code as-is. They're written to be useful in order, but each stands alone.

### Prompt 1 — find your feet

```
I've just cloned this repository and I'm not a developer. Read README.md and
docs/working-together.md, then explain in plain English: what this tool does,
what I'm responsible for as the owner of scenario 1, and what I should do first.
Don't change anything yet.
```

*(Brian: say scenario 3.)*

### Prompt 2 — check your machine is ready

```
Check that everything this repo needs is installed on my machine, then run
node tools/verify-local.js uc1 and tell me whether it worked. If Node is missing
or too old, tell me exactly what to install. Don't change any files.
```

You should see the unit tests pass, a plan summary, and a per-account table of percentages.

### Prompt 3 — understand your scenario

```
I own scenario 1. Open apps-script/Scenario1.gs and walk me through what it defines
— the companies, the people, the courses, the enrolments — and what numbers the demo
is supposed to produce. For each headline number, show me which rows produce it.
```

This is the one worth reading slowly. The data model is the whole job.

### Prompt 4 — make your first change

```
In scenario 1, change Alderfield Financial from 16 learners to 20 while keeping its
required-training completion at 25%. Edit apps-script/Scenario1.gs, then run
node tools/verify-local.js uc1 and show me the numbers before and after. Tell me
about anything that changed which I didn't ask for.
```

Nothing here touches the sheet or the portal. You can do this as many times as you like.

### Prompt 5 — put your change into the sheet

When the local numbers look right:

```
I'm ready to put my scenario into the spreadsheet. Show me the contents of
apps-script/Scenario1.gs so I can copy it, and remind me of the exact menu steps
for loading and then refreshing it.
```

Then: open the Apps Script editor from the sheet (**Extensions → Apps Script**), select
`Scenario1`, replace its contents, save. Back in the sheet:
**MCP Demo Seeder → Scenario 1 → Load Sheet Data**, then **Refresh — add & update**.

### Prompt 6 — before you write to the real portal

```
Before I seed my scenario to the live portal, tell me what's about to happen: how many
records, which portal, and specifically what can't be undone afterwards. Read CLAUDE.md
for the constraints.
```

Worth doing at least once. Some of what this tool writes is difficult to remove, and the answer is
better read beforehand.

### Prompt 7 — changing a shared file

Scenario files are yours alone. Everything else is shared by all three of you, in one live script
project with no undo.

```
I need to change a shared file, not my scenario file. Walk me through the process in
docs/working-together.md, and do the parts you can: run the local checker for uc1, uc2
and uc3, bump TOOLKIT_VERSION, and draft the commit message and the Slack post for me
to review. Don't commit or push until I've read them.
```

### Prompt 8 — when something looks wrong

```
Something isn't behaving the way I expected: [describe it]. Before changing anything,
check CLAUDE.md — it records API constraints we've already measured, and several
surprising behaviours are documented there rather than being bugs.
```

---

## Saving your work

In GitHub Desktop, changed files appear on the left. Write a short summary of *what and why*, click
**Commit to main**, then **Push origin**.

Push your scenario file whenever you've changed it. Michael and the other owner won't see it
otherwise — and if your laptop dies, neither will you.

---

## Three things not to do

**Don't commit credentials.** Anything under `apps-script/local/` is ignored on purpose. If Claude
Code ever offers to add a `.env` file, say no.

**Don't paste a shared file without following the process.** There's one Apps Script project behind
the sheet. The moment you paste, it's live for all three of you — no staging, no undo. The process
in `docs/working-together.md` exists so nobody discovers your change by having something break.

**Don't add a course for a "deliberate gap" category.** Data Import & Migration, Certification &
Compliance and Billing & Subscription must have no training content — scenario 2's entire story is
that these categories are uncovered. Validation blocks it, but know why before you argue with it.

---

## What to read, and when

| | |
|---|---|
| `docs/working-together.md` | How the three of you share one workbook. **Read this first.** |
| `README.md` | Repo orientation, mostly aimed at Claude Code |
| `CLAUDE.md` | The full spec, every measured API constraint, and three incident write-ups. Long, but the answer to most "why is it like this?" questions |
| `docs/mcp-validation.md` | How to test that a seeded scenario actually answers the demo questions |
| `INSTALL.md` | Only if you're setting up a new sheet from scratch |
