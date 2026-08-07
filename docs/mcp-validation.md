# MCP validation script — Scenario 1

Run these against the **seeded portal** and grade the answers against the "what the data actually
says" column. This is not the demo prompt library; it is a test of whether the dataset can be read
correctly by an AI that has not been told how it was built.

## Step 0 — prove the MCP reads the portal you seeded

**Do this before anything else.** `Verify` proves the portal the *seeder writes to* is correct. It
knows nothing about which portal the *MCP reads*, and there is no way for it to find out. Those can
be two different portals, and on 2026-08-06 they were.

Ask the assistant:

```
List the LearnUpon groups whose name starts with "Customer:".
```

> Pass: the nine `Customer: <Company>` groups we seeded.
> Fail: anything else — including a single pre-existing `Customer: ACME`. If the seeded groups are
> absent, the MCP is pointed somewhere else and every prompt below will return other people's data
> while looking like a data-quality failure.

Confirm with:

```
Is there a course called "Getting Started with ACME"? Any users at alderfield-financial.com?
```

Both must be found. If either is missing, stop and fix the connection before testing anything.

**Decide about the three manual touches first.** In-progress enrollments cannot be created by the
API, so Helen Cross, Tom Whitlock and Marcus Feld are currently *not started* rather than partially
complete. Either do the three UI touches before testing, or accept that section D will be wrong in a
known way. Either is fine — just know which you are testing.

Anchor date at seed time: **2026-08-06**. Every due date below is in the past.

## What the data actually says

Ground truth, read from the portal, not from the plan:

| Account | Enrollments | Completed | % | Overdue |
|---|---|---|---|---|
| Alderfield Financial | 28 | 7 | **25%** | 20 |
| Copperlane Hospitality | 21 | 13 | **62%** | 3 |
| Vantage Ridge Manufacturing | 18 | 16 | **89%** | 1 |
| Cobalt Peak, Fernpath, Harborline, Halden, Larkspur, Northwind | — | — | **100%** | 0 |

Alderfield by course:

| Course | Enrolled | Completed | Not started |
|---|---|---|---|
| Getting Started with ACME | 16 | 6 | 10 |
| ACME Admin Essentials | 4 | 1 | 3 |
| Platform Setup & Configuration | 4 | 0 | 4 |
| Launch Readiness Checkpoint | 4 | 0 | 4 |

Alderfield's named people:

| Person | Job Title | Admin | State |
|---|---|---|---|
| Dana Reyes | Platform Administrator | yes | Getting Started complete; **Admin Essentials not started, due 2026-07-30** |
| Marcus Feld | IT Integrations Lead | yes | Getting Started + Admin Essentials complete; Platform Setup not started |
| Tom Whitlock | Compliance Officer | yes | nothing started at all |
| Priya Raman | Operations Manager | no | Getting Started complete |
| Helen Cross | VP Operations | no | Getting Started not started |

**No one at Alderfield has completed Launch Readiness Checkpoint.**

---

## Findings from the live run — 2026-08-06

Run against ACME through the connector, reading the reporting layer the demo uses.

**1. The strays are still present.** `enrolment_total: 44` for Alderfield, and
`course_completion_rate: 15.91`. Turning off the auto-enrolment rule stops *new* ones; the 127
already created still need `Developer → Remove Stray Enrollments`. Until then every percentage in
the demo is wrong. This is the only blocking item.

**2. Job Title works.** `ud_118989` returns "Platform Administrator", "IT Integrations Lead",
"Compliance Officer" and so on. Story 3's "which of these are administrators?" is answerable. Note
the fourth admin is **Kiera Vasquez (IT Administrator)** — a generated learner. The spec's line
"None of their four administrators has passed the Launch Readiness Checkpoint" is correct; the line
"risk concentrates in three people" should say four, and name her.

**3. `created_at` exposes the backdating.** This is the one to design around:

```
Dana Reyes   Getting Started   enrolled 08/06/2026   completed 06/13/2026   due 07/18/2026
```

Enrolled in August, completed in June, due in July. Enrollment `created_at` is not settable, so every
completed enrollment reads as finished before it existed. `date_started` mirrors `date_completed`, so
those two agree with each other — only `created_at` is anomalous, and for the established cohort it
is off by 300+ days.

**Mitigation: the prompt library must pin the columns it asks for and never include `created_at`.**
Nothing in Story 1 or Story 3 needs it — they read status, due date and completion date. But an
unconstrained "show me the enrollment details" will surface it, and a follow-up like "when were they
assigned this?" walks straight into it.

**4. Reporting quirks worth knowing.**

| Observed | Consequence |
|---|---|
| `row_count: 0` while `enrolment_total: 44` | A model told to quote `summary` verbatim may report "0 rows" |
| `due_date_passed` is `"yes_string"` / `"no_string"` | Not booleans; models coped, but do not assume |
| Course names carry a ` v.1` suffix | Demo answers say "Getting Started with ACME v.1" |
| `date_completed` is `MM/DD/YYYY HH:MM` | US format regardless of portal timezone |

---

## A. Plumbing — can it see our data at all?

**A1.** `How many learners are in the group "Customer: Alderfield Financial", and what courses are they enrolled in?`

> Pass: 16 learners, four courses named exactly as above.
> Fail: cannot find the group, or returns learners from other groups too.

**A2.** `List every course whose name starts with "Getting Started" and tell me how many people are enrolled in each.`

> Pass: finds "Getting Started with ACME" with 127 enrollments.
> Watch for: the `num_enrolled` field on the course record reads 0 — it is stale. If the answer says
> zero, the model used the course record instead of the enrollments report, and the whole demo will
> misreport. **This is the single most important plumbing check.**

---

## B. Story 1 — the risk board

**B1 (headline).** `Which customers currently in onboarding are behind on their required training?`

> Pass: names Alderfield, Copperlane and Vantage Ridge, ranked with Alderfield worst.
> The interesting part is *how* it defines "required training". See E1.

**B2.** `For each of Alderfield, Copperlane and Vantage Ridge, what percentage of their required training is complete?`

> Pass: **25% / 62% / 89%**, or within a point.
> Fail: any other denominator — e.g. counting only started enrollments, or counting courses rather
> than enrollments. If it returns 43% for Alderfield it counted people, not enrollments.

**B3.** `How many overdue training assignments does Alderfield have?`

> Pass: **20**.
> Acceptable: 20 of 28, or "20 of the 21 incomplete".

**B4.** `Compare the three in-flight accounts to the six that have already completed onboarding.`

> Pass: recognises the six established accounts are at 100%.
> This is the reference band the risk board draws.

---

## C. Story 3 — the account drill-down

**C1 (headline).** `For Alderfield Financial, who has not completed their required training and what specifically is outstanding?`

> Pass: names Dana Reyes, Tom Whitlock, Marcus Feld and Helen Cross with the right courses.
> Fail: returns only email addresses with no names, or omits the course names.

**C2 (the load-bearing one).** `Which of these people are administrators?`

> Pass: Dana Reyes, Marcus Feld, Tom Whitlock — **read from the `Job Title` custom user field**.
> Fail: says it cannot tell. LearnUpon does not expose membership type in the enrollments report, so
> the job title field is the only signal. If this fails, Story 3 has no punchline and we need to
> change how admin-ness is encoded.

**C3.** `Nobody has completed the Launch Readiness Checkpoint at Alderfield — is that right?`

> Pass: confirms 0 of 4.

**C4.** `Which single person is the biggest blocker to Alderfield going live, and why?`

> Pass: Dana Reyes — Platform Administrator, Admin Essentials not started, overdue since 2026-07-30.
> This is the sentence the demo is built to produce. If the model gets here unaided, Story 3 works.

---

## D. In-progress — only if you did the three manual touches

**D1.** `Is anyone at Alderfield part-way through a course and stalled?`

> If touched: Marcus Feld ~30% through Platform Setup & Configuration, Tom Whitlock ~15% through
> Admin Essentials, Helen Cross ~40% through Getting Started.
> If not touched: expect "no one" — that is correct for the current data, not a bug.

**D2.** `When did each of them last access their course?`

> Tests whether `date_last_accessed` surfaces. Only meaningful after the manual touches.

---

## E. The traps — what we are really testing

**E1. Does it find the right denominator unaided?**

Ask B2 in a fresh conversation with no prior context. "Required training" is not a reportable object
in LearnUpon — there is no Learning Journey dimension in the enrollments report. The design instead
relies on each account's users being enrolled in *nothing but* their required courses, so a
group-filtered report **is** the required set.

> If the model works that out by itself, the data model holds.
> If it asks "what counts as required training?", the prompt library must say so explicitly. That is
> a cheap fix, but we need to know now rather than on stage.

**E2. Does it invent a go-live date?**

Ask: `Which of these accounts is at risk of missing its go-live date?`

> Correct answer today: **it cannot know.** Go-live dates live in HubSpot, which is not seeded yet.
> Pass: says so, or answers only on training completion.
> **Fail: invents a date or implies one exists.** That would be a hallucination on the exact claim
> the demo makes, and worth knowing before HubSpot lands.

**E3. Does it notice the completion dates are odd?**

Some completions predate their own enrollment record, because enrollment `created_at` is not
settable and completions are backdated.

> Ask: `Show me the enrollment dates and completion dates for Priya Raman.`
> Pass: reports them without editorialising.
> Fail: flags the inconsistency out loud. If it does, we need to know whether that would happen in
> front of a prospect.

**E4. Does it handle the ampersand?**

> Ask: `How many people have completed "Platform Setup & Configuration"?`
> Pass: 26 portal-wide, 0 at Alderfield. Tests that the `&` in the title does not break filtering.

---

## How to record results

For each prompt, note: **answer correct? / answer confident? / did it need a follow-up?**

The third column matters most. A right answer that took three clarifying questions is a demo that
stalls. Anything in section E that fails is a change to the data model or the prompt library, and
both are cheaper this week than next.
