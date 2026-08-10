# Scenario 1 — HubSpot readiness

**For Nik. Nothing in `Scenario1.gs` has been changed** — these are proposals, and the file is yours.

Scenario 1's HubSpot data (9 accounts, 9 deals, 7 ticket rows) was written before the HubSpot half
of the toolkit existed. Now that it does, uc1's data has been run through the expander and checked
against the real portal. Most of it works. Four things need a decision from you.

Three are five-minute edits. One is a genuine design question about Story 3.

---

## The short version

| # | What | Effect if not done | Effort |
|---|---|---|---|
| 1 | `Tickets.status` says `open` / `closed` | **Ticket seeding refuses to run** | 5 min |
| 2 | Only 2 of 9 accounts have People | 6 tickets have no requester | 15 min |
| 3 | 5 of 9 `industry` values aren't valid in HubSpot | Those companies show a blank industry | 5 min |
| 4 | 7 of 9 accounts have no tickets at all | Story 3 only works for Alderfield | your call |

Nothing here blocks the LearnUpon side. Scenario 1's LearnUpon seed is done and correct.

---

## 1. Ticket statuses must name real pipeline stages — this one blocks

`scenario1Tickets_()` uses `open` and `closed`. The portal's Support Pipeline has four stages:

```
New          Waiting on contact          Waiting on us          Closed
```

`closed` matches "Closed" fine. **`open` matches nothing.**

Until this week the seeder would have quietly filed all 12 of those tickets as **Closed** and
reported `Created: 12, Failed: 0`. That is now a hard refusal instead — it creates nothing and tells
you which values it could not resolve. The change was made because a ticket in the wrong stage tells
the opposite of the intended story, and this project has twice shipped a silent wrong answer that a
green success dialog hid.

**Suggested mapping**, though the choice is yours:

| Current | Suggested | Why |
|---|---|---|
| `open` (data-import, Alderfield) | `Waiting on us` | Reads as "we owe them an answer", which is the point — there is no course to send them to |
| `open` (certification, Alderfield) | `Waiting on us` | same |
| `open` (data-import, Copperlane) | `New` | Recently raised, not yet triaged. Gives the board some variety |
| `closed` (all four rows) | `Closed` | Already matches; capitalisation is not required |

Any of the four labels is valid. Mixing them makes the ticket board look real rather than uniform.

---

## 2. Seven of nine accounts have no People, so their tickets have no requester

`scenario1People_()` covers `alderfield` (5) and `vantageridge` (2). Copperlane has two ticket rows
and no personas, so the expander warns:

```
Tickets row 5 (copperlane/data-import): no contact to file them, so 4 ticket(s) will have no requester.
Tickets row 6 (copperlane/billing):     no contact to file them, so 2 ticket(s) will have no requester.
```

Those tickets will still be created and still be attached to the company, so "how many tickets has
Copperlane filed?" works. What breaks is the cross-system join — **"has the person filing these
tickets done the training?"** is scenario 1's sharpest question and it needs a named contact whose
email matches a LearnUpon user.

Filler learners are deliberately *not* created as HubSpot contacts: 120 contacts nobody asks about
is noise. Named personas are the join.

**Suggestion:** add two or three people to any account you want tickets for. One admin and one
learner is enough. They cost nothing on the LearnUpon side — they are already being created as
users, they just aren't in `People`.

---

## 3. Five industry values aren't in HubSpot's list

`industry` is a fixed enumeration of 148 options. Anything else is dropped and the field lands blank.
The seeder resolves loosely — case, spaces, ampersands and slashes are all ignored — but it cannot
invent a match.

```
Alderfield Financial          Financial Services   -> FINANCIAL_SERVICES     ok
Copperlane Hospitality        Hospitality          -> HOSPITALITY            ok
Harborline Insurance Group    Insurance            -> INSURANCE              ok
Larkspur Retail Group         Retail               -> RETAIL                 ok

Vantage Ridge Manufacturing   Manufacturing        *** no match ***
Cobalt Peak Software          Software             *** no match ***
Fernpath Health Systems       Healthcare           *** no match ***
Halden Energy Partners        Energy               *** no match ***
Northwind Logistics           Logistics            *** no match ***
```

**Suggested replacements**, all confirmed present in the portal:

| Account | Change to |
|---|---|
| Vantage Ridge | `Machinery` or `Industrial Automation` |
| Cobalt Peak | `Computer Software` |
| Fernpath | `Hospital & Health Care` |
| Halden | `Oil & Energy` |
| Northwind | `Logistics and Supply Chain` |

Purely cosmetic — nothing in the demo reads `industry` today. Worth fixing only because a blank
field looks like a seeding bug to anyone reviewing the portal.

---

## 4. The real question: is Story 3 meant to work for one account or nine?

Right now uc1 has **19 tickets across 3 accounts** — 12 at Alderfield, 6 at Copperlane, 1 at
Vantage Ridge. The six established accounts have none.

That is fine if Story 3 is *"tell me about Alderfield"*. It is not fine if anyone asks
*"which of my customers is struggling most?"*, because six of nine will answer "no tickets" and
look healthier than the ones you deliberately made healthy.

**Three options, and I would pick B:**

**A. Leave it.** Story 3 is Alderfield-specific and the demo script never asks a portfolio question.
Zero work, and a real risk if anyone goes off-script.

**B. Give the six established accounts a small tail — two to five tickets each, mostly closed.**
About 20 more tickets, one afternoon. A live customer with zero tickets in a year is not credible,
and the contrast between in-flight accounts (many open) and established ones (few, closed) *is*
Story 3's finding rather than an accident of what got authored.

**C. Full portfolio.** Match scenario 2's density everywhere. Not worth it — uc2 already carries the
ticket-volume story, and duplicating it in uc1 makes the two scenarios compete.

Worth knowing before you decide: **scenario 2 contributes 217 tickets to the same portal**, and
"top ticket categories in the last 90 days" is a portal-wide question. uc1's 19 tickets will sit
inside that. The category taxonomy is shared, so this is additive, not conflicting — but if a demo
question is scoped to a category rather than to an account, uc2's volume dominates the answer.

---

## What has already been done for you

- **The Onboarding deal pipeline now exists** in portal 23399533 (id `924734831`), created because
  all nine uc1 deals name it and it was missing entirely. Stages, in order:

  ```
  Kickoff -> Data Migration -> Training & Enablement -> UAT -> Go-Live
  ```

  The four stages uc1 already uses are all there; `Kickoff` was added so the pipeline reads as a
  real progression. If you want different stages, say so and they can be changed — no deals exist
  on it yet.

- **Deals now refuse rather than fall back.** Before the pipeline existed, seeding uc1's deals would
  have put $558,000 of pipeline into "Sales Pipeline / Appointment Scheduled" and reported success.
  It now refuses and names the valid stages.

- **`Verify HubSpot`** reconciles plan → portal per account and per category, and checks the four
  things a green seed can still get wrong: ticket landed, right stage, attached to a company, and
  the date still inside its declared window.

- **`Refresh HubSpot dates`** re-anchors every ticket and deal to today's `T`. It matters less for
  uc1 than uc2 (nothing in uc1 depends on a rolling 90-day window) but it keeps deal close dates and
  the company go-live dates honest as the demo date approaches.

---

## Suggested order

1. Fix `Tickets.status` (#1) — without it the tickets phase will not run
2. Decide on #4, since it determines how much data you are writing
3. Add People for whichever accounts get tickets (#2)
4. Fix the industry values (#3) while you are in the file anyway
5. `node tools/verify-local.js uc1`, then Preview, then seed HubSpot phases 5–7
6. `Verify HubSpot`

Ask if any of this is unclear or you disagree with the reasoning — particularly on #4, which is a
storytelling decision rather than a technical one, and yours to make.
