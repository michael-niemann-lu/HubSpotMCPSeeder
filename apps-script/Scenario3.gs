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
 * THREE STORIES, THIRTEEN ACCOUNTS, THREE GROUPS:
 *
 *   Group A — renewal risk, 8 accounts (Story 1)
 *     A renewal date plus a required-training percentage. bramwell, thackeray, delgado and fairholt
 *     are below 50% ("gone quiet") — flag-worthy. corvallis, whitlock and osgood are not, so "pull
 *     accounts with a renewal in 60 days" doesn't return an all-red list. vantree is the DELIBERATE
 *     CONTROL: its completion (8%) is the worst of the whole scenario, but its renewal is 95 days out
 *     — outside the window — so a correct discovery query must exclude it. If it shows up in a "next
 *     60 days" answer, the query is filtering on training alone and ignoring the renewal date.
 *     Ranking the four flagged accounts by ARR: bramwell 58k > delgado 51k > thackeray 46k > fairholt 39k.
 *
 *   Group B — expansion trigger, 5 accounts (Story 2)
 *     Each has a cohort certified on the Advanced course in the last 30 days, at different depths and
 *     with different deal states, so "build me a shortlist, ranked" has a real spread to rank:
 *       calloway    22 of 30 certified   NO deal   — the biggest opportunity, and nobody has acted on it
 *       praxis      15 of 24 certified   Expansion deal at Discovery
 *       fenwick      9 of 14 certified   NO deal   — the original gap case
 *       brightwell   6 of 10 certified   Expansion deal at Proposal Sent (further along than praxis's)
 *       nettlecombe  4 of 8  certified   NO deal   — modest, deliberately borderline
 *     3 of 5 have no deal at all despite the signal — that imbalance IS the story. None of these five
 *     renew soon (all 100+ days out), so they never enter Group A's 60-day pool — expansion and
 *     renewal risk stay legible as separate signals even though they share one sheet.
 *
 *   Group C — none; Story 3 (One-Screen Health View) draws on Groups A and B directly. corvallis
 *   (healthy, quiet on support) against bramwell (at-risk, noisy on support) is the built-in
 *   side-by-side; the full 13-account roster is what a "priority order this week" query ranks.
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
      // Group A — renewal risk
      bramwell: { completion: 22,
        note: 'flagged — largest ARR among the flagged accounts, quiet 90+ days, renews in 42 days' },
      thackeray: { completion: 38, note: 'flagged, mid ARR, renews in 55 days' },
      delgado: { completion: 47, note: 'flagged, borderline under 50%, renews in 20 days (soonest)' },
      fairholt: { completion: 33, note: 'flagged, smallest ARR of the flagged group, renews in 48 days' },
      corvallis: { completion: 88, note: 'healthy contrast — largest ARR overall, renews in 30 days' },
      whitlock: { completion: 64, note: 'moderate, smallest ARR of Group A, renews in 58 days' },
      osgood: { completion: 55, note: 'moderate, large ARR, renews in 15 days — soon but not at risk' },
      vantree: { completion: 8,
        note: 'CONTROL — worst completion in the scenario, but renews in 95 days, OUTSIDE the 60-day ' +
          'window. Must not appear in a correctly-filtered "renewal in 60 days" answer.' },
      // Group B — expansion trigger
      calloway: { completion: 80,
        note: '22 of 30 seats Advanced-certified in the last 30 days — the biggest cohort — and NO deal exists' },
      praxis: { completion: 73, note: '15 of 24 seats certified, Expansion deal open at Discovery' },
      fenwick: { completion: 71, note: '9 of 14 seats certified, NO expansion deal yet' },
      brightwell: { completion: 70,
        note: '6 of 10 seats certified, Expansion deal open at Proposal Sent' },
      nettlecombe: { completion: 56, note: '4 of 8 seats certified — modest, deliberately borderline, no deal' }
    },
    notes: [
      'Story 1 — accounts renewing within 60 days, ranked by ARR among those under 50%: ' +
        'bramwell 58k > delgado 51k > thackeray 46k > fairholt 39k. vantree must NOT appear (renews in 95 days).',
      'Story 2 — ranked by certified headcount: calloway 22 > praxis 15 > fenwick 9 > brightwell 6 > ' +
        'nettlecombe 4. 3 of 5 (calloway, fenwick, nettlecombe) have no deal despite the signal.',
      'Story 3 — corvallis (healthy, quiet on support) vs bramwell (at-risk, noisy on support) is the ' +
        'intended side-by-side; the full 13-account roster is the priority-order pool.'
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
    // --- Group A: renewal risk (Story 1) ----------------------------------------------------
    ['bramwell', 'uc3', 'Bramwell Freight Holdings', 'bramwellfreight.com', 'Freight & Logistics',
      'established', 'Growth', 58000, 'T-500', 'S+60', 'S+60', 18, 4, 22, '', UC3_CSM_OWNER, '',
      'Flagship at-risk account. Renewal in 42 days, quiet for 90+ days, largest ARR among the flagged accounts.'],
    ['thackeray', 'uc3', 'Thackeray Insurance Group', 'thackerayinsurance.com', 'Insurance',
      'established', 'Growth', 46000, 'T-480', 'S+60', 'S+60', 16, 4, 38, '', UC3_CSM_OWNER, '',
      'Renewal in 55 days, flagged (under 50%).'],
    ['delgado', 'uc3', 'Delgado Manufacturing', 'delgadomfg.com', 'Manufacturing',
      'established', 'Growth', 51000, 'T-520', 'S+60', 'S+60', 17, 4, 47, '', UC3_CSM_OWNER, '',
      'Renewal in 20 days — soonest of the group — and borderline flagged just under 50%.'],
    ['fairholt', 'uc3', 'Fairholt Logistics', 'fairholtlogistics.com', 'Freight & Logistics',
      'established', 'Growth', 39000, 'T-460', 'S+60', 'S+60', 15, 4, 33, '', UC3_CSM_OWNER, '',
      'Renewal in 48 days, flagged. Smallest ARR of the flagged group, so it ranks last on the ' +
      '"biggest at-risk deals" list even though it is just as disengaged.'],
    ['corvallis', 'uc3', 'Corvallis Health Systems', 'corvallishealth.com', 'Healthcare',
      'established', 'Enterprise', 88000, 'T-600', 'S+60', 'S+60', 25, 5, 88, '', UC3_CSM_OWNER, '',
      'Healthy contrast. Renewal in 30 days, largest ARR overall, not flagged, quiet on support too — ' +
      'the Story 3 comparison partner for bramwell.'],
    ['whitlock', 'uc3', 'Whitlock Retail Co', 'whitlockretail.com', 'Retail',
      'established', 'Essentials', 28000, 'T-450', 'S+60', 'S+60', 14, 3, 64, '', UC3_CSM_OWNER, '',
      'Renewal in 58 days, moderate engagement, smallest ARR in Group A, not flagged.'],
    ['osgood', 'uc3', 'Osgood Telecom', 'osgoodtelecom.com', 'Telecommunications',
      'established', 'Enterprise', 67000, 'T-430', 'S+60', 'S+60', 20, 5, 55, '', UC3_CSM_OWNER, '',
      'Renewal in 15 days — the soonest of anyone — but moderate engagement, not flagged. Shows a ' +
      'near-term renewal is not automatically a risk signal.'],
    ['vantree', 'uc3', 'Vantree Media', 'vantreemedia.com', 'Media & Entertainment',
      'established', 'Growth', 33000, 'T-380', 'S+60', 'S+60', 12, 3, 8, '', UC3_CSM_OWNER, '',
      'THE CONTROL ACCOUNT. Worst completion in the whole scenario (8%), but renews in 95 days — ' +
      'outside the 60-day window. A correct "renewing in the next 60 days" answer excludes it; if an ' +
      'assistant includes it, it is filtering on training alone and ignoring the renewal date.'],

    // --- Group B: expansion trigger (Story 2) -----------------------------------------------
    ['calloway', 'uc3', 'Calloway Systems', 'callowaysystems.com', 'Industrial IoT',
      'established', 'Enterprise', 74000, 'T-570', 'S+60', 'S+60', 30, 6, 80, '', UC3_CSM_OWNER, '',
      'Largest certified cohort in the scenario (22 of 30 seats, last 30 days) and NO expansion deal ' +
      'exists — the single biggest missed opportunity in the dataset. Renews in 150 days, well ' +
      'outside Group A\'s window.'],
    ['praxis', 'uc3', 'Praxis Robotics', 'praxisrobotics.com', 'Robotics & Automation',
      'established', 'Growth', 62000, 'T-550', 'S+60', 'S+60', 24, 5, 73, '', UC3_CSM_OWNER, '',
      '15 of 24 seats Advanced-certified in the last 30 days. An Expansion deal is already open at ' +
      'Discovery. Renews in 120 days.'],
    ['fenwick', 'uc3', 'Fenwick Analytics', 'fenwickanalytics.io', 'Software',
      'established', 'Growth', 39000, 'T-400', 'S+60', 'S+60', 14, 3, 71, '', UC3_CSM_OWNER, '',
      '9 of 14 seats Advanced-certified in the last 30 days, but NO expansion deal exists yet. ' +
      'Renews in 135 days.'],
    ['brightwell', 'uc3', 'Brightwell Analytics', 'brightwellanalytics.com', 'Business Intelligence',
      'established', 'Growth', 44000, 'T-410', 'S+60', 'S+60', 10, 3, 70, '', UC3_CSM_OWNER, '',
      '6 of 10 seats certified in the last 30 days. Its Expansion deal is already at Proposal Sent — ' +
      'further along than praxis\'s — showing the signal can arrive after the conversation has ' +
      'already started, not only before it. Renews in 130 days.'],
    ['nettlecombe', 'uc3', 'Nettlecombe Commerce', 'nettlecombecommerce.com', 'E-Commerce',
      'established', 'Essentials', 21000, 'T-360', 'S+60', 'S+60', 8, 2, 56, '', UC3_CSM_OWNER, '',
      'Only 4 of 8 seats certified — the smallest, most borderline case in Group B, deliberately ' +
      'included so a ranked shortlist has a clear bottom entry, not just a cliff after fenwick. ' +
      'No deal exists. Renews in 110 days.']
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

    // Fairholt
    ['fairholt.talia', 'uc3', 'Talia', 'Brennan', '', 'IT Systems Manager', true, 'fairholt', ''],
    ['fairholt.dominic', 'uc3', 'Dominic', 'Reyes', '', 'Platform Administrator', true, 'fairholt', ''],
    ['fairholt.imogen', 'uc3', 'Imogen', 'Sato', '', 'Fleet Operations Lead', false, 'fairholt', ''],

    // Corvallis — the healthy contrast
    ['corvallis.hana', 'uc3', 'Hana', 'Petrova', '', 'Platform Administrator', true, 'corvallis', ''],
    ['corvallis.tobias', 'uc3', 'Tobias', 'Reyes', '', 'Clinical Systems Lead', true, 'corvallis', ''],
    ['corvallis.wren', 'uc3', 'Wren', 'Adeyemi', '', 'Training Coordinator', false, 'corvallis',
      'Champions training internally — the reason this account stays healthy.'],

    // Whitlock
    ['whitlock.omar', 'uc3', 'Omar', 'Delacroix', '', 'IT Manager', true, 'whitlock', ''],
    ['whitlock.jenna', 'uc3', 'Jenna', 'Marsh', '', 'Store Operations Lead', false, 'whitlock', ''],
    ['whitlock.paolo', 'uc3', 'Paolo', 'Ferrante', '', 'Merchandising Manager', false, 'whitlock', ''],

    // Osgood
    ['osgood.felix', 'uc3', 'Felix', 'Marchetti', '', 'Network Systems Administrator', true, 'osgood', ''],
    ['osgood.ruth', 'uc3', 'Ruth', 'Okafor', '', 'Compliance Manager', true, 'osgood', ''],
    ['osgood.dean', 'uc3', 'Dean', 'Whitcombe', '', 'Customer Operations Lead', false, 'osgood', ''],

    // Vantree — the control account
    ['vantree.ana', 'uc3', 'Ana', 'Kowalski', '', 'IT Administrator', true, 'vantree', ''],
    ['vantree.liam', 'uc3', 'Liam', 'Fitzgerald', '', 'Production Operations Manager', false, 'vantree', ''],
    ['vantree.sofia', 'uc3', 'Sofia', 'Berger', '', 'Content Operations Lead', false, 'vantree', ''],

    // Calloway — the biggest expansion cohort, no deal
    ['calloway.priyanka', 'uc3', 'Priyanka', 'Suresh', '', 'Head of IT', true, 'calloway',
      'Advanced-certified.'],
    ['calloway.jonas', 'uc3', 'Jonas', 'Kessler', '', 'Systems Administrator', true, 'calloway',
      'Advanced-certified.'],
    ['calloway.maeve', 'uc3', 'Maeve', 'Doyle', '', 'Automation Program Lead', false, 'calloway',
      'Advanced-certified. Drove the certification push across the whole team — nobody has followed ' +
      'up commercially yet.'],

    // Praxis — the expansion account WITH a deal already open
    ['praxis.zara', 'uc3', 'Zara', 'Khoury', '', 'Head of Platform Engineering', true, 'praxis',
      'Advanced-certified. Sponsoring the push to certify the whole engineering group.'],
    ['praxis.milo', 'uc3', 'Milo', 'Andersen', '', 'Systems Administrator', true, 'praxis',
      'Advanced-certified.'],
    ['praxis.ines', 'uc3', 'Ines', 'Duarte', '', 'Automation Lead', false, 'praxis',
      'Advanced-certified. The internal champion driving adoption.'],

    // Fenwick — the original expansion account WITHOUT a deal yet
    ['fenwick.tariq', 'uc3', 'Tariq', 'Salim', '', 'Data Platform Lead', true, 'fenwick',
      'Advanced-certified.'],
    ['fenwick.chloe', 'uc3', 'Chloe', 'Bennett', '', 'Systems Administrator', true, 'fenwick',
      'Advanced-certified.'],
    ['fenwick.reid', 'uc3', 'Reid', 'Colston', '', 'Analytics Manager', false, 'fenwick',
      'Advanced-certified. Nobody has opened an expansion conversation despite this.'],

    // Brightwell — deal already further along than praxis's
    ['brightwell.theo', 'uc3', 'Theo', 'Lindgren', '', 'Data Platform Lead', true, 'brightwell',
      'Advanced-certified.'],
    ['brightwell.aisha', 'uc3', 'Aisha', 'Rahman', '', 'Systems Administrator', true, 'brightwell',
      'Advanced-certified.'],
    ['brightwell.connor', 'uc3', 'Connor', 'Blake', '', 'Analytics Operations Manager', false, 'brightwell',
      'Advanced-certified.'],

    // Nettlecombe — the modest, borderline case
    ['nettlecombe.ivy', 'uc3', 'Ivy', 'Prescott', '', 'IT Manager', true, 'nettlecombe',
      'Advanced-certified.'],
    ['nettlecombe.oscar', 'uc3', 'Oscar', 'Faraday', '', 'Ecommerce Operations Lead', true, 'nettlecombe',
      'Advanced-certified.'],
    ['nettlecombe.freya', 'uc3', 'Freya', 'Lindholm', '', 'Merchandising Analyst', false, 'nettlecombe', '']
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
      'Story 2\'s certification. Completions here, clustered in the last 30 days across Group B, ' +
      'are the expansion signal.']
  ];
}

function scenario3Enrollments_() {
  // row_id, use_case, account_key, course_key, audience, [enroll_count ƒ], completed_count,
  // in_progress_count, [not_started_count ƒ], due_offset, complete_offset, in_progress_pct,
  // last_access_offset, notes
  //
  // In-progress can't be created by the API (spike 1b) — every row below is completed/not-started
  // only. due_offset is in the FUTURE for the healthier accounts so their remaining incomplete
  // learners are not yet overdue; it's in the PAST for the at-risk group so "gone quiet" shows up as
  // overdue, not just incomplete. Every account here carries a Core Fundamentals row; Group B
  // accounts carry a second row on the Advanced course, and required_complete_actual blends both.
  return [
    // --- Group A: Core Fundamentals, the renewal-risk baseline ------------------------------
    ['e01', 'uc3', 'bramwell', 'uc3-core-fundamentals', 'all', '', '', 4, 0, '',
      'T-90..T-30', 'T-160..T-100', '', '', '4 of 18 = 22%.'],
    ['e02', 'uc3', 'thackeray', 'uc3-core-fundamentals', 'all', '', '', 6, 0, '',
      'T-75..T-20', 'T-150..T-90', '', '', '6 of 16 = 38%.'],
    ['e03', 'uc3', 'delgado', 'uc3-core-fundamentals', 'all', '', '', 8, 0, '',
      'T-55..T-15', 'T-110..T-60', '', '', '8 of 17 = 47%.'],
    ['e10', 'uc3', 'fairholt', 'uc3-core-fundamentals', 'all', '', '', 5, 0, '',
      'T-80..T-25', 'T-170..T-110', '', '', '5 of 15 = 33%.'],
    ['e04', 'uc3', 'corvallis', 'uc3-core-fundamentals', 'all', '', '', 22, 0, '',
      'T+15..T+35', 'T-200..T-60', '', '', '22 of 25 = 88%. Remaining three are not yet due.'],
    ['e05', 'uc3', 'whitlock', 'uc3-core-fundamentals', 'all', '', '', 9, 0, '',
      'T+5..T+25', 'T-160..T-70', '', '', '9 of 14 = 64%.'],
    ['e11', 'uc3', 'osgood', 'uc3-core-fundamentals', 'all', '', '', 11, 0, '',
      'T+5..T+20', 'T-140..T-50', '', '', '11 of 20 = 55%.'],
    ['e12', 'uc3', 'vantree', 'uc3-core-fundamentals', 'all', '', '', 1, 0, '',
      'T-100..T-40', 'T-200..T-150', '', '',
      '1 of 12 = 8%, the worst in the scenario — but renewal is outside the 60-day window (T+95).'],

    // --- Group B: Core Fundamentals baseline, plus Advanced Certification (the signal) -----
    ['e13', 'uc3', 'calloway', 'uc3-core-fundamentals', 'all', '', '', 26, 0, '',
      'T+20..T+40', 'T-220..T-80', '', '', '26 of 30 on the baseline course.'],
    ['e14', 'uc3', 'calloway', 'uc3-advanced-cert', 'all', '', '', 22, 0, '',
      'T-45..T-20', 'T-25..T-5', '', '',
      '22 of 30 seats certified in the last 30 days. Blended with e13: (26+22)/(30+30) = 80%. No deal.'],
    ['e06', 'uc3', 'praxis', 'uc3-core-fundamentals', 'all', '', '', 20, 0, '',
      'T+10..T+30', 'T-210..T-70', '', '', '20 of 24 on the baseline course.'],
    ['e08', 'uc3', 'praxis', 'uc3-advanced-cert', 'all', '', '', 15, 0, '',
      'T-45..T-20', 'T-25..T-5', '', '',
      '15 of 24 seats certified in the last 30 days. Blended with e06: (20+15)/(24+24) = 73%.'],
    ['e07', 'uc3', 'fenwick', 'uc3-core-fundamentals', 'all', '', '', 11, 0, '',
      'T+10..T+30', 'T-190..T-60', '', '', '11 of 14 on the baseline course.'],
    ['e09', 'uc3', 'fenwick', 'uc3-advanced-cert', 'all', '', '', 9, 0, '',
      'T-45..T-20', 'T-25..T-5', '', '',
      '9 of 14 seats certified in the last 30 days. Blended with e07: (11+9)/(14+14) = 71%.'],
    ['e15', 'uc3', 'brightwell', 'uc3-core-fundamentals', 'all', '', '', 8, 0, '',
      'T+15..T+35', 'T-180..T-60', '', '', '8 of 10 on the baseline course.'],
    ['e16', 'uc3', 'brightwell', 'uc3-advanced-cert', 'all', '', '', 6, 0, '',
      'T-45..T-20', 'T-25..T-5', '', '',
      '6 of 10 seats certified in the last 30 days. Blended with e15: (8+6)/(10+10) = 70%. Deal at Proposal Sent.'],
    ['e17', 'uc3', 'nettlecombe', 'uc3-core-fundamentals', 'all', '', '', 5, 0, '',
      'T+15..T+35', 'T-150..T-50', '', '', '5 of 8 on the baseline course.'],
    ['e18', 'uc3', 'nettlecombe', 'uc3-advanced-cert', 'all', '', '', 4, 0, '',
      'T-45..T-20', 'T-25..T-5', '', '',
      '4 of 8 seats certified in the last 30 days. Blended with e17: (5+4)/(8+8) = 56%. Modest, no deal.']
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
  // priority track engagement: the at-risk group files more, higher-priority tickets; the
  // healthy/expansion accounts stay quiet.
  return [
    // Group A
    ['t01', 'uc3', 'bramwell', 'data-import', 'T-90', 'T', 5, 'bramwell.lena,bramwell.derek',
      'HIGH', 'open', 30, 'Migration-era issues resurfacing — nobody trained on it since.'],
    ['t02', 'uc3', 'bramwell', 'billing', 'T-90', 'T', 3, 'bramwell.sara', 'MEDIUM', 'open', 20, ''],
    ['t03', 'uc3', 'thackeray', 'certification', 'T-90', 'T', 4, 'thackeray.nadia,thackeray.owen',
      'MEDIUM', 'open', 24, ''],
    ['t04', 'uc3', 'thackeray', 'billing', 'T-90', 'T', 2, 'thackeray.carl', 'LOW', 'closed', 14, ''],
    ['t05', 'uc3', 'delgado', 'integrations', 'T-90', 'T', 3, 'delgado.priya', 'MEDIUM', 'open', 18, ''],
    ['t10', 'uc3', 'fairholt', 'data-import', 'T-90', 'T', 4, 'fairholt.talia,fairholt.dominic',
      'HIGH', 'open', 28, 'Same migration-gap pattern as bramwell.'],
    ['t06', 'uc3', 'corvallis', 'reporting', 'T-90', 'T', 1, 'corvallis.wren', 'LOW', 'closed', 8,
      'Healthy account — quiet on support too, the Story 3 contrast with bramwell.'],
    ['t07', 'uc3', 'whitlock', 'user-management', 'T-90', 'T', 2, 'whitlock.omar', 'LOW', 'closed', 10, ''],
    ['t11', 'uc3', 'osgood', 'reporting', 'T-90', 'T', 2, 'osgood.ruth', 'MEDIUM', 'open', 16, ''],
    ['t12', 'uc3', 'vantree', 'billing', 'T-90', 'T', 3, 'vantree.ana', 'MEDIUM', 'open', 19,
      'Friction exists here too, but this account is excluded from Story 1 by renewal timing, not by health.'],

    // Group B
    ['t13', 'uc3', 'calloway', 'integrations', 'T-90', 'T', 1, 'calloway.jonas', 'LOW', 'closed', 6,
      'Engaged account, minimal friction — consistent with a certified, expansion-ready customer.'],
    ['t08', 'uc3', 'praxis', 'integrations', 'T-90', 'T', 1, 'praxis.milo', 'LOW', 'closed', 6,
      'Engaged account, minimal friction.'],
    ['t09', 'uc3', 'fenwick', 'reporting', 'T-90', 'T', 1, 'fenwick.chloe', 'LOW', 'closed', 7, ''],
    ['t14', 'uc3', 'brightwell', 'reporting', 'T-90', 'T', 1, 'brightwell.aisha', 'LOW', 'closed', 5, ''],
    ['t15', 'uc3', 'nettlecombe', 'user-management', 'T-90', 'T', 2, 'nettlecombe.oscar',
      'MEDIUM', 'open', 12, '']
  ];
}

function scenario3Deals_() {
  // row_id, use_case, account_key, pipeline, stage, amount, close_offset, deal_type, notes
  //
  // Group A: one Renewals deal per account. Group B: an Expansion deal ONLY on praxis and
  // brightwell — calloway, fenwick and nettlecombe deliberately have none, which is the "signal
  // exists, nobody has acted on it" gap Story 2 is built to surface, at three different depths.
  return [
    ['d01', 'uc3', 'bramwell', 'Renewals', 'Discovery', 58000, 'T+42', 'renewal',
      'Stalled at an early stage — matches the disengagement the training data already shows.'],
    ['d02', 'uc3', 'thackeray', 'Renewals', 'Proposal Sent', 46000, 'T+55', 'renewal', ''],
    ['d03', 'uc3', 'delgado', 'Renewals', 'Negotiation', 51000, 'T+20', 'renewal', ''],
    ['d07', 'uc3', 'fairholt', 'Renewals', 'Discovery', 39000, 'T+48', 'renewal', ''],
    ['d04', 'uc3', 'corvallis', 'Renewals', 'Negotiation', 88000, 'T+30', 'renewal',
      'Smooth renewal, consistent with the healthy training picture.'],
    ['d05', 'uc3', 'whitlock', 'Renewals', 'Proposal Sent', 28000, 'T+58', 'renewal', ''],
    ['d08', 'uc3', 'osgood', 'Renewals', 'Negotiation', 67000, 'T+15', 'renewal', ''],
    ['d09', 'uc3', 'vantree', 'Renewals', 'Discovery', 33000, 'T+95', 'renewal',
      'The renewal that puts this account outside the 60-day window despite its training data.'],

    ['d06', 'uc3', 'praxis', 'Expansion', 'Discovery', 18000, 'T+60', 'expansion',
      'Opened on the back of the certification wave.'],
    ['d10', 'uc3', 'brightwell', 'Expansion', 'Proposal Sent', 15000, 'T+50', 'expansion',
      'Further along than praxis\'s — the conversation started before or alongside the certification wave.']
    // calloway, fenwick, nettlecombe: no deal. That absence, against a real certification signal, IS the finding.
  ];
}
