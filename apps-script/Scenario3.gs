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
 * Company names, domains and course titles must not collide with uc1 or uc2 — they are global in a
 * shared portal, and validation will refuse duplicates with an explanation.
 *
 * THREE STORIES, SEVEN ACCOUNTS, TWO GROUPS:
 *
 *   Group A — renewal risk (bramwell, thackeray, delgado, corvallis, whitlock)
 *     Story 1: a renewal inside 60 days plus a required-training percentage. bramwell, thackeray
 *     and delgado are below 50% ("gone quiet") — flag-worthy. corvallis and whitlock are not, and
 *     exist so "pull 5 accounts with a renewal in 60 days" doesn't return an all-red list. Ranking
 *     the flagged three by ARR: bramwell 58k > delgado 51k > thackeray 46k.
 *
 *   Group B — expansion trigger (praxis, fenwick)
 *     Story 2: both have a cohort certified on the Advanced course in the last 30 days — the warm
 *     upsell signal. praxis (15 of 24 seats) already has an open Expansion deal; fenwick (9 of 14)
 *     deliberately does NOT — that gap (signal exists, no deal yet) is the point of the story.
 *
 *   Story 3 (One-Screen Health View) draws on both groups: corvallis (healthy, quiet on support)
 *   against bramwell (at-risk, noisy on support) is the intended side-by-side contrast.
 *
 * Ticket categories are a taxonomy OWNED BY uc2 (docs/working-together.md) — scenario3Categories_
 * stays empty, and scenario3Tickets_ below references uc2's existing category keys (data-import,
 * billing, certification, reporting, user-management, integrations) rather than redeclaring them.
 * CAVEAT: node tools/verify-local.js loads each scenario in ISOLATION, so a uc3-only local run has
 * no TicketCategories rows to match against and Tickets will show as 0 generated — that is a harness
 * limitation (Expand.gs silently skips a ticket row whose category isn't found), not a bug. In the
 * real shared sheet, uc1/uc2 have already loaded their categories, so this resolves correctly there.
 */

const UC3_CSM_OWNER = 'brian.mchugh@learnupon.com';

/**
 * Module donor for created courses. Reuses the module id verified against the sandbox in the
 * scenario 1 spike (CLAUDE.md, spike 4). MODULE IDS ARE PORTAL-SPECIFIC — check with
 * Setup -> Find a Module before seeding a real portal; Settings.default_source_module_id is the
 * fallback when this id doesn't exist there.
 */
const UC3_SOURCE_MODULE = 7788730;

function scenario3Meta() {
  return {
    use_case: 'uc3',
    name: 'Upsell and Renewal Readiness',
    owner_name: 'Brian',
    owner_email: '',
    notes: 'Renewal risk surfaced early by training engagement, plus certification completions ' +
      'that self-identify expansion-ready accounts.'
  };
}

/** Informative only. Verify prints these next to what the portal actually holds. */
function scenario3Expected() {
  return {
    accounts: {
      bramwell: { completion: 22,
        note: 'Story 1 flagship — largest ARR among the flagged accounts, quiet 90+ days' },
      thackeray: { completion: 38, note: 'Story 1 — flagged, mid ARR' },
      delgado: { completion: 47, note: 'Story 1 — flagged, borderline under 50%, soonest renewal' },
      corvallis: { completion: 88, note: 'healthy contrast — largest ARR overall, smooth renewal' },
      whitlock: { completion: 64, note: 'moderate, smallest ARR, not flagged' },
      praxis: { completion: 73,
        note: 'Story 2 — 15 of 24 seats Advanced-certified in the last 30 days, Expansion deal already open' },
      fenwick: { completion: 71,
        note: 'Story 2 — 9 of 14 seats Advanced-certified in the last 30 days, NO expansion deal yet' }
    },
    notes: [
      'Story 1 ranking by ARR among accounts under 50%: bramwell 58k > delgado 51k > thackeray 46k',
      'Story 2 ranking by certified headcount: praxis 15 > fenwick 9 — fenwick is the alert-worthy gap',
      'Story 3 side-by-side: corvallis (healthy, quiet on support) vs bramwell (at-risk, noisy on support)'
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
    ['bramwell', 'uc3', 'Bramwell Freight Holdings', 'bramwellfreight.com', 'Freight & Logistics',
      'established', 'Growth', 58000, 'T-500', 'S+60', 'S+60', 18, 4, 22, '', UC3_CSM_OWNER, '',
      'Story 1 flagship. Renewal in 42 days, quiet for 90+ days, largest ARR among the flagged accounts.'],
    ['thackeray', 'uc3', 'Thackeray Insurance Group', 'thackerayinsurance.com', 'Insurance',
      'established', 'Growth', 46000, 'T-480', 'S+60', 'S+60', 16, 4, 38, '', UC3_CSM_OWNER, '',
      'Story 1. Renewal in 55 days, flagged (under 50%).'],
    ['delgado', 'uc3', 'Delgado Manufacturing', 'delgadomfg.com', 'Manufacturing',
      'established', 'Growth', 51000, 'T-520', 'S+60', 'S+60', 17, 4, 47, '', UC3_CSM_OWNER, '',
      'Story 1. Renewal in 20 days — soonest of the group — and borderline flagged just under 50%.'],
    ['corvallis', 'uc3', 'Corvallis Health Systems', 'corvallishealth.com', 'Healthcare',
      'established', 'Enterprise', 88000, 'T-600', 'S+60', 'S+60', 25, 5, 88, '', UC3_CSM_OWNER, '',
      'Healthy contrast. Renewal in 30 days, largest ARR overall, not flagged, quiet on support too — ' +
      'the Story 3 comparison partner for bramwell.'],
    ['whitlock', 'uc3', 'Whitlock Retail Co', 'whitlockretail.com', 'Retail',
      'established', 'Essentials', 28000, 'T-450', 'S+60', 'S+60', 14, 3, 64, '', UC3_CSM_OWNER, '',
      'Story 1. Renewal in 58 days, moderate engagement, smallest ARR, not flagged.'],
    ['praxis', 'uc3', 'Praxis Robotics', 'praxisrobotics.com', 'Robotics & Automation',
      'established', 'Growth', 62000, 'T-550', 'S+60', 'S+60', 24, 5, 73, '', UC3_CSM_OWNER, '',
      'Story 2. 15 of 24 seats Advanced-certified in the last 30 days. An Expansion deal is already open.'],
    ['fenwick', 'uc3', 'Fenwick Analytics', 'fenwickanalytics.io', 'Software',
      'established', 'Growth', 39000, 'T-400', 'S+60', 'S+60', 14, 3, 71, '', UC3_CSM_OWNER, '',
      'Story 2. 9 of 14 seats Advanced-certified in the last 30 days, but NO expansion deal exists yet ' +
      '— the readiness-without-a-deal gap the story is built to surface.']
  ];
}

function scenario3People_() {
  // person_key, use_case, first_name, last_name, [email ƒ], job_title, is_admin, account_key, notes
  // Story 3 recommends named people to enrol, so each account needs at least three with real titles.
  return [
    // Bramwell — the flagship at-risk account
    ['bramwell.lena', 'uc3', 'Lena', 'Whitmore', '', 'IT Systems Manager', true, 'bramwell',
      'Hasn\'t logged in to LearnUpon in 60+ days.'],
    ['bramwell.derek', 'uc3', 'Derek', 'Okonkwo', '', 'Platform Administrator', true, 'bramwell', ''],
    ['bramwell.sara', 'uc3', 'Sara', 'Lindqvist', '', 'Operations Director', false, 'bramwell',
      'The one person still engaging with training at all.'],

    // Thackeray
    ['thackeray.owen', 'uc3', 'Owen', 'Bright', '', 'IT Administrator', true, 'thackeray', ''],
    ['thackeray.nadia', 'uc3', 'Nadia', 'Fischer', '', 'Compliance Lead', true, 'thackeray', ''],
    ['thackeray.carl', 'uc3', 'Carl', 'Whitfield', '', 'Claims Operations Manager', false, 'thackeray', ''],

    // Delgado
    ['delgado.priya', 'uc3', 'Priya', 'Nathan', '', 'Systems Administrator', true, 'delgado', ''],
    ['delgado.marcus', 'uc3', 'Marcus', 'Boyle', '', 'Plant Operations Manager', true, 'delgado', ''],
    ['delgado.elena', 'uc3', 'Elena', 'Cortez', '', 'HR Business Partner', false, 'delgado', ''],

    // Corvallis — the healthy contrast
    ['corvallis.hana', 'uc3', 'Hana', 'Petrova', '', 'Platform Administrator', true, 'corvallis', ''],
    ['corvallis.tobias', 'uc3', 'Tobias', 'Reyes', '', 'Clinical Systems Lead', true, 'corvallis', ''],
    ['corvallis.wren', 'uc3', 'Wren', 'Adeyemi', '', 'Training Coordinator', false, 'corvallis',
      'Champions training internally — the reason this account stays healthy.'],

    // Whitlock
    ['whitlock.omar', 'uc3', 'Omar', 'Delacroix', '', 'IT Manager', true, 'whitlock', ''],
    ['whitlock.jenna', 'uc3', 'Jenna', 'Marsh', '', 'Store Operations Lead', false, 'whitlock', ''],
    ['whitlock.paolo', 'uc3', 'Paolo', 'Ferrante', '', 'Merchandising Manager', false, 'whitlock', ''],

    // Praxis — the expansion account WITH a deal already open
    ['praxis.zara', 'uc3', 'Zara', 'Khoury', '', 'Head of Platform Engineering', true, 'praxis',
      'Advanced-certified. Sponsoring the push to certify the whole engineering group.'],
    ['praxis.milo', 'uc3', 'Milo', 'Andersen', '', 'Systems Administrator', true, 'praxis',
      'Advanced-certified.'],
    ['praxis.ines', 'uc3', 'Ines', 'Duarte', '', 'Automation Lead', false, 'praxis',
      'Advanced-certified. The internal champion driving adoption.'],

    // Fenwick — the expansion account WITHOUT a deal yet
    ['fenwick.tariq', 'uc3', 'Tariq', 'Salim', '', 'Data Platform Lead', true, 'fenwick',
      'Advanced-certified.'],
    ['fenwick.chloe', 'uc3', 'Chloe', 'Bennett', '', 'Systems Administrator', true, 'fenwick',
      'Advanced-certified.'],
    ['fenwick.reid', 'uc3', 'Reid', 'Colston', '', 'Analytics Manager', false, 'fenwick',
      'Advanced-certified. Nobody has opened an expansion conversation despite this.']
  ];
}

function scenario3Courses_() {
  // course_key, use_case, title, [reference_code ƒ], source_module_id, notes
  //
  // NEVER create a course for a deliberate gap category. Story 1 collapses if you do, and
  // validation blocks it.
  return [
    ['uc3-core-fundamentals', 'uc3', 'Customer Success Platform Fundamentals', '', UC3_SOURCE_MODULE,
      'The baseline required course every uc3 account is measured against — this is what ' +
      'required_complete_actual reflects for Story 1 and Story 3.'],
    ['uc3-advanced-cert', 'uc3', 'Advanced Platform Certification', '', UC3_SOURCE_MODULE,
      'Story 2\'s certification. Completions here, clustered in the last 30 days at praxis and ' +
      'fenwick, are the expansion signal.']
  ];
}

function scenario3Enrollments_() {
  // row_id, use_case, account_key, course_key, audience, [enroll_count ƒ], completed_count,
  // in_progress_count, [not_started_count ƒ], due_offset, complete_offset, in_progress_pct,
  // last_access_offset, notes
  //
  // In-progress can't be created by the API (spike 1b) — every row below is completed/not-started
  // only. due_offset is in the FUTURE for the healthier accounts (corvallis, whitlock, praxis,
  // fenwick) so their remaining incomplete learners are not yet overdue; it's in the PAST for the
  // at-risk group (bramwell, thackeray, delgado) so "gone quiet" shows up as overdue, not just
  // incomplete.
  return [
    // --- Core Fundamentals: the required-training baseline for every account -----------------
    ['e01', 'uc3', 'bramwell', 'uc3-core-fundamentals', 'all', '', '', 4, 0, '',
      'T-90..T-30', 'T-160..T-100', '', '', '4 of 18 = 22%.'],
    ['e02', 'uc3', 'thackeray', 'uc3-core-fundamentals', 'all', '', '', 6, 0, '',
      'T-75..T-20', 'T-150..T-90', '', '', '6 of 16 = 38%.'],
    ['e03', 'uc3', 'delgado', 'uc3-core-fundamentals', 'all', '', '', 8, 0, '',
      'T-55..T-15', 'T-110..T-60', '', '', '8 of 17 = 47%.'],
    ['e04', 'uc3', 'corvallis', 'uc3-core-fundamentals', 'all', '', '', 22, 0, '',
      'T+15..T+35', 'T-200..T-60', '', '', '22 of 25 = 88%. Remaining three are not yet due.'],
    ['e05', 'uc3', 'whitlock', 'uc3-core-fundamentals', 'all', '', '', 9, 0, '',
      'T+5..T+25', 'T-160..T-70', '', '', '9 of 14 = 64%.'],
    ['e06', 'uc3', 'praxis', 'uc3-core-fundamentals', 'all', '', '', 20, 0, '',
      'T+10..T+30', 'T-210..T-70', '', '', '20 of 24 on the baseline course.'],
    ['e07', 'uc3', 'fenwick', 'uc3-core-fundamentals', 'all', '', '', 11, 0, '',
      'T+10..T+30', 'T-190..T-60', '', '', '11 of 14 on the baseline course.'],

    // --- Advanced Certification: the Story 2 signal, praxis and fenwick only ----------------
    ['e08', 'uc3', 'praxis', 'uc3-advanced-cert', 'all', '', '', 15, 0, '',
      'T-45..T-20', 'T-25..T-5', '', '',
      '15 of 24 seats certified in the last 30 days. Blended with e06: (20+15)/(24+24) = 73%.'],
    ['e09', 'uc3', 'fenwick', 'uc3-advanced-cert', 'all', '', '', 9, 0, '',
      'T-45..T-20', 'T-25..T-5', '', '',
      '9 of 14 seats certified in the last 30 days. Blended with e07: (11+9)/(14+14) = 71%.']
  ];
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
  // The ticket taxonomy is shared and owned by uc2 (docs/working-together.md). scenario3Tickets_
  // below references uc2's existing category keys directly rather than redeclaring them here —
  // redeclaring would risk silently overwriting uc2's canonical labels/subject_templates on Load,
  // since TicketCategories merges by key and the LAST scenario loaded wins for a shared key.
  return [];
}

function scenario3Tickets_() {
  // row_id, use_case, account_key, category_key, window_start, window_end, count,
  // contact_person_keys, priority, status, resolution_hours, notes
  //
  // Category keys (data-import, billing, certification, reporting, user-management, integrations)
  // are uc2's — see scenario3Categories_ above for why they aren't redeclared here. Volume and
  // priority track the Story 1/3 split: the at-risk trio files more, higher-priority tickets; the
  // healthy/expansion accounts stay quiet.
  return [
    ['t01', 'uc3', 'bramwell', 'data-import', 'T-90', 'T', 5, 'bramwell.lena,bramwell.derek',
      'HIGH', 'open', 30, 'Migration-era issues resurfacing — nobody trained on it since.'],
    ['t02', 'uc3', 'bramwell', 'billing', 'T-90', 'T', 3, 'bramwell.sara', 'MEDIUM', 'open', 20, ''],
    ['t03', 'uc3', 'thackeray', 'certification', 'T-90', 'T', 4, 'thackeray.nadia,thackeray.owen',
      'MEDIUM', 'open', 24, ''],
    ['t04', 'uc3', 'thackeray', 'billing', 'T-90', 'T', 2, 'thackeray.carl', 'LOW', 'closed', 14, ''],
    ['t05', 'uc3', 'delgado', 'integrations', 'T-90', 'T', 3, 'delgado.priya', 'MEDIUM', 'open', 18, ''],
    ['t06', 'uc3', 'corvallis', 'reporting', 'T-90', 'T', 1, 'corvallis.wren', 'LOW', 'closed', 8,
      'Healthy account — quiet on support too, the Story 3 contrast with bramwell.'],
    ['t07', 'uc3', 'whitlock', 'user-management', 'T-90', 'T', 2, 'whitlock.omar', 'LOW', 'closed', 10, ''],
    ['t08', 'uc3', 'praxis', 'integrations', 'T-90', 'T', 1, 'praxis.milo', 'LOW', 'closed', 6,
      'Engaged account, minimal friction.'],
    ['t09', 'uc3', 'fenwick', 'reporting', 'T-90', 'T', 1, 'fenwick.chloe', 'LOW', 'closed', 7, '']
  ];
}

function scenario3Deals_() {
  // row_id, use_case, account_key, pipeline, stage, amount, close_offset, deal_type, notes
  //
  // Five renewals (Story 1) plus one expansion deal on praxis only — fenwick deliberately has NO
  // deal here, which is the whole point of Story 2's "signal exists, no deal yet" gap.
  return [
    ['d01', 'uc3', 'bramwell', 'Renewals', 'Discovery', 58000, 'T+42', 'renewal',
      'Stalled at an early stage — matches the disengagement the training data already shows.'],
    ['d02', 'uc3', 'thackeray', 'Renewals', 'Proposal Sent', 46000, 'T+55', 'renewal', ''],
    ['d03', 'uc3', 'delgado', 'Renewals', 'Negotiation', 51000, 'T+20', 'renewal', ''],
    ['d04', 'uc3', 'corvallis', 'Renewals', 'Negotiation', 88000, 'T+30', 'renewal',
      'Smooth renewal, consistent with the healthy training picture.'],
    ['d05', 'uc3', 'whitlock', 'Renewals', 'Proposal Sent', 28000, 'T+58', 'renewal', ''],
    ['d06', 'uc3', 'praxis', 'Expansion', 'Discovery', 18000, 'T+60', 'expansion',
      'Opened on the back of the certification wave. fenwick has an equivalent signal and no deal — see notes there.']
  ];
}
