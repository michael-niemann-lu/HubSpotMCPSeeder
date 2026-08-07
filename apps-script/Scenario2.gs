/**
 * Scenario2.gs — Knowledge Gaps vs Support Tickets.  Owner: Michael.
 *
 * DATA ONLY. Edit this file (Claude Code is fine for it), paste it into the Apps Script editor,
 * then run Scenario 2 ▸ Load Sheet Data. The file wins on Load: any hand edits made to uc2 rows in
 * the sheet are replaced.
 *
 * Every row is a POSITIONAL array. Run Developer ▸ Show Column Contract for the exact column order
 * of each tab. Load refuses any row of the wrong width rather than letting the values shift.
 *
 * NAMING CONVENTION, and it matters: prefix every top-level const with UC2_ and every function with
 * scenario2. Apps Script compiles all files as one unit, so two scenario files declaring the same
 * const name is a syntax error that takes down the whole project for everyone.
 *
 * The story this data has to produce:
 *   Story 1  ticket categories with no course are the content roadmap
 *   Story 2  the Integrations Masterclass bent the curve — completers dropped, non-completers flat
 *   Story 3  a ranked target list: high tickets, low training engagement
 *
 * STILL TO DECIDE before this can be seeded (see CLAUDE.md, "Three owners"):
 *   - Company names. The draft reuses five of uc1's established accounts with DIFFERENT headcounts
 *     and completion percentages. Validation will refuse the duplicates: company names become
 *     LearnUpon group titles in one shared portal. Either pick new names, or agree shared numbers
 *     with Nik.
 *   - Whether uc1's tickets count toward "top categories over the last 90 days". They will, because
 *     the question is portal-wide.
 */

function scenario2Meta() {
  return {
    use_case: 'uc2',
    name: 'Knowledge Gaps vs Support Tickets',
    owner_name: 'Michael',
    owner_email: '',
    notes: 'Ticket categories with no course are the content roadmap. Depends on the deliberate gaps staying empty.'
  };
}

/** Informative only. Verify prints these next to what the portal actually holds. */
function scenario2Expected() {
  return {
    accounts: {
      // northwind:  { completion: 28, note: 'top target — high tickets, low training' },
      // larkspur:   { completion: 41 },
      // halden:     { completion: 35 },
      // fernpath:   { completion: 86, note: 'the proof account' },
      // cobaltpeak: { completion: 92, note: 'contrast — fully trained, quiet' }
    },
    notes: [
      'Integrations tickets should fall 38 -> 13 quarter over quarter',
      'The fall should sit entirely with accounts that completed the Masterclass'
    ]
  };
}

function loadScenario2() {
  loadScenarioData_(scenario2Meta(), {
    Accounts: scenario2Accounts_,
    People: scenario2People_,
    Courses: scenario2Courses_,
    Enrollments: scenario2Enrollments_,
    PersonaStates: scenario2PersonaStates_,
    TicketCategories: scenario2Categories_,
    Tickets: scenario2Tickets_,
    Deals: scenario2Deals_
  });
}

// ---------------------------------------------------------------------------

function scenario2Accounts_() {
  // account_key, use_case, company_name, domain, industry, cohort, plan_tier, arr,
  // onboarding_start_offset, target_go_live_offset, actual_go_live_offset, user_count, admin_count,
  // required_complete_target, [required_complete_actual ƒ], csm_owner_email, [lu_group_title ƒ], notes
  return [
    // ['northwind2', 'uc2', 'Northwind Logistics', 'northwindlogistics.com', 'Logistics',
    //   'established', 'Growth', 42000, 'T-400', 'S+60', 'S+60', 14, 3, 28, '', UC2_CSM_OWNER, '',
    //   'Top target: highest ticket volume, lowest training engagement.'],
  ];
}

function scenario2People_() {
  // person_key, use_case, first_name, last_name, [email ƒ], job_title, is_admin, account_key, notes
  // Story 3 recommends named people to enrol, so each account needs at least three with real titles.
  return [];
}

function scenario2Courses_() {
  // course_key, use_case, title, [reference_code ƒ], source_module_id, notes
  //
  // NEVER create a course for a deliberate gap category. Story 1 collapses if you do, and
  // validation blocks it.
  return [];
}

function scenario2Enrollments_() {
  // row_id, use_case, account_key, course_key, audience, [enroll_count ƒ], completed_count,
  // in_progress_count, [not_started_count ƒ], due_offset, complete_offset, in_progress_pct,
  // last_access_offset, notes
  //
  // The date chain is the whole scenario: course launch -> completion wave -> ticket decline, in
  // that order with visible spacing. complete_offset carries it; "assigned date" is not settable.
  return [];
}

function scenario2PersonaStates_() {
  // row_id, use_case, person_key, course_key, status, percentage, complete_offset,
  // last_access_offset, notes
  //
  // in_progress cannot be created by the API — each one is a manual click in the portal UI after
  // seeding. Preview lists them under MANUAL STEP. Keep the count small.
  return [];
}

function scenario2Categories_() {
  // category_key, label, course_key, is_deliberate_gap, notes
  //
  // ONE taxonomy shared by all three scenarios; Load merges by category_key rather than replacing.
  // The three gaps are load-bearing: Story 1 IS "these categories have no training".
  return [
    ['data-import', 'Data Import & Migration', '', true,
      'The top category and the clearest content gap. Affects every account. Do not create a course for it.'],
    ['certification', 'Certification & Compliance', '', true, 'Second gap. Growing quarter on quarter.'],
    ['billing', 'Billing & Subscription', '', true, 'Third gap, lower volume.'],
    ['reporting', 'Reporting & Analytics', '', false,
      'Course exists but enrolment is low — the "course exists, nobody took it" finding.'],
    ['user-management', 'User Management', '', false, 'Covered by User & Group Administration.'],
    ['integrations', 'Integrations', '', false,
      'Covered by the Integrations Masterclass, launched T-150. This is the Story 2 deflection case.']
  ];
}

function scenario2Tickets_() {
  // row_id, use_case, account_key, category_key, window_start, window_end, count,
  // contact_person_keys, priority, status, resolution_hours, notes
  //
  // One row per account x category x window. The expander spreads `count` tickets across the window
  // rather than clustering them. Ticket contacts should be the same people who later completed the
  // course — that is what lets the demo make an individual-level claim.
  return [];
}

function scenario2Deals_() {
  // row_id, use_case, account_key, pipeline, stage, amount, close_offset, deal_type, notes
  // One renewal deal on the top target, closing around T+75, escalates the Story 3 ask.
  return [];
}
