/**
 * Scenario3.gs — Upsell and Renewal Readiness.  Owner: Brian.
 *
 * DATA ONLY. Edit this file (Claude Code is fine for it), paste it into the Apps Script editor,
 * then run Scenario 3 ▸ Load Sheet Data. The file wins on Load: any hand edits made to uc3 rows in
 * the sheet are replaced.
 *
 * Every row is a POSITIONAL array. Run Developer ▸ Show Column Contract for the exact column order
 * of each tab. Load refuses any row of the wrong width rather than letting the values shift.
 *
 * NAMING CONVENTION, and it matters: prefix every top-level const with UC3_ and every function with
 * scenario3. Apps Script compiles all files as one unit, so two scenario files declaring the same
 * const name is a syntax error that takes down the whole project for everyone.
 *
 * The story this data has to produce: learners taking training on features outside their plan tier,
 * at accounts with a renewal approaching, are self-identifying expansion opportunities.
 *
 * Company names, domains and course titles must not collide with uc1 or uc2 — they are global in a
 * shared portal, and validation will refuse duplicates with an explanation.
 */

function scenario3Meta() {
  return {
    use_case: 'uc3',
    name: 'Upsell and Renewal Readiness',
    owner_name: 'Brian',
    owner_email: '',
    notes: 'Learners taking courses outside their plan tier, with a renewal approaching.'
  };
}

/** Informative only. Verify prints these next to what the portal actually holds. */
function scenario3Expected() {
  return {
    accounts: {
      // northwind:  { completion: 28, note: 'top target — high tickets, low training' },
      // larkspur:   { completion: 41 },
      // halden:     { completion: 35 },
      // fernpath:   { completion: 86, note: 'the proof account' },
      // cobaltpeak: { completion: 92, note: 'contrast — fully trained, quiet' }
    },
    notes: [
      'Accounts renewing in the next 90 days with learners in out-of-plan courses'
    ]
  };
}

function loadScenario3() {
  loadScenarioData_(scenario3Meta(), {
    Accounts: scenario3Accounts_,
    People: scenario3People_,
    Courses: scenario3Courses_,
    Enrollments: scenario3Enrollments_,
    PersonaStates: scenario3PersonaStates_,
    TicketCategories: scenario3Categories_,
    Tickets: scenario3Tickets_,
    Deals: scenario3Deals_
  });
}

// ---------------------------------------------------------------------------

function scenario3Accounts_() {
  // account_key, use_case, company_name, domain, industry, cohort, plan_tier, arr,
  // onboarding_start_offset, target_go_live_offset, actual_go_live_offset, user_count, admin_count,
  // required_complete_target, [required_complete_actual ƒ], csm_owner_email, [lu_group_title ƒ], notes
  return [
    // ['northwind2', 'uc3', 'Northwind Logistics', 'northwindlogistics.com', 'Logistics',
    //   'established', 'Growth', 42000, 'T-400', 'S+60', 'S+60', 14, 3, 28, '', UC3_CSM_OWNER, '',
    //   'Top target: highest ticket volume, lowest training engagement.'],
  ];
}

function scenario3People_() {
  // person_key, use_case, first_name, last_name, [email ƒ], job_title, is_admin, account_key, notes
  // Story 3 recommends named people to enrol, so each account needs at least three with real titles.
  return [];
}

function scenario3Courses_() {
  // course_key, use_case, title, [reference_code ƒ], source_module_id, notes
  //
  // NEVER create a course for a deliberate gap category. Story 1 collapses if you do, and
  // validation blocks it.
  return [];
}

function scenario3Enrollments_() {
  // row_id, use_case, account_key, course_key, audience, [enroll_count ƒ], completed_count,
  // in_progress_count, [not_started_count ƒ], due_offset, complete_offset, in_progress_pct,
  // last_access_offset, notes
  //
  // The date chain is the whole scenario: course launch -> completion wave -> ticket decline, in
  // that order with visible spacing. complete_offset carries it; "assigned date" is not settable.
  return [];
}

function scenario3PersonaStates_() {
  // row_id, use_case, person_key, course_key, status, percentage, complete_offset,
  // last_access_offset, notes
  //
  // in_progress cannot be created by the API — each one is a manual click in the portal UI after
  // seeding. Preview lists them under MANUAL STEP. Keep the count small.
  return [];
}

function scenario3Categories_() {
  // The ticket taxonomy is shared and owned by uc2. Leave this empty unless scenario 3 genuinely
  // needs a category nobody else has.
  return [];
}

function scenario3Tickets_() {
  // row_id, use_case, account_key, category_key, window_start, window_end, count,
  // contact_person_keys, priority, status, resolution_hours, notes
  //
  // One row per account x category x window. The expander spreads `count` tickets across the window
  // rather than clustering them. Ticket contacts should be the same people who later completed the
  // course — that is what lets the demo make an individual-level claim.
  return [];
}

function scenario3Deals_() {
  // row_id, use_case, account_key, pipeline, stage, amount, close_offset, deal_type, notes
  // One renewal deal on the top target, closing around T+75, escalates the Story 3 ask.
  return [];
}
