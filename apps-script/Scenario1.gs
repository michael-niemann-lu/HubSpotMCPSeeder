/**
 * Scenario1.gs — the worked example: Customer Onboarding Health.
 *
 * Scenario 1 ▸ Load Sheet Data writes this into the uc1 rows of the authoring tabs. Edit this file
 * (Claude Code is fine for it), paste it into the editor, then Load — the file wins on Load, so any
 * hand edits to uc1 rows in the sheet are replaced.
 *
 * This file is data only. Every row is a positional array: run Developer -> Show Column Contract to
 * see the exact column order for each tab, and loadScenarioData_ refuses any row of the wrong width
 * rather than letting the values silently shift.
 *
 * NAMING CONVENTION, and it matters: every top-level const in a scenario file is prefixed with its
 * use case (UC1_...), and every function with its number (scenario1Foo_). Apps Script compiles all
 * files as one unit, so two files declaring the same const is a syntax error that takes down the
 * whole project for all three scenarios.
 *
 * In-progress is capped at the three named personas who need it, because spike 1b proved the API
 * cannot create that state — each one is a manual click in the portal UI. Everything else is
 * completed or not-started, which are the only two states the API can actually produce.
 *
 * The numbers are engineered so the demo's headline claims fall out of the data:
 *
 *   Alderfield        25% of required training complete, heavily overdue, launch in 12 days
 *   Copperlane        62%, recoverable but slipping
 *   Vantage Ridge     89%, on track
 *   Trained early     Cobalt Peak 31, Fernpath 35, Harborline 36 days to go-live -> mean 34
 *   Lagged            Halden 62, Larkspur 74, Northwind 89                       -> mean 75
 *                     a 41-day / 54% difference, which is the Story 2 claim
 */

const UC1_CSM_OWNER = 'casey.doyle@acmesoftware.com';

/** Established cohort: [key, company, domain, industry, tier, arr, startOffset, coreDay, goLiveDay, users, admins] */
const UC1_ESTABLISHED = [
  ['cobaltpeak', 'Cobalt Peak Software', 'cobaltpeak.io', 'Software', 'Enterprise', 96000, 'T-300', 11, 31, 14, 3],
  ['fernpath', 'Fernpath Health Systems', 'fernpathhealth.com', 'Healthcare', 'Enterprise', 120000, 'T-330', 19, 35, 18, 4],
  ['harborline', 'Harborline Insurance Group', 'harborline-insurance.com', 'Insurance', 'Growth', 60000, 'T-360', 15, 36, 11, 3],
  ['halden', 'Halden Energy Partners', 'haldenenergy.com', 'Energy', 'Growth', 54000, 'T-240', 52, 62, 12, 3],
  ['larkspur', 'Larkspur Retail Group', 'larkspurretail.com', 'Retail', 'Essentials', 30000, 'T-390', 66, 74, 15, 4],
  ['northwind', 'Northwind Logistics', 'northwindlogistics.com', 'Logistics', 'Growth', 42000, 'T-420', 81, 89, 20, 5]
];

const UC1_COURSE_KEYS = ['nce-getting-started', 'nce-admin-essentials', 'nce-platform-setup', 'nce-launch-readiness'];
// We build courses rather than cloning them: POST /courses sets an exact title and reference_code
// in one synchronous call, where a clone is named "<source> - Copy" and is async. This is the module
// we attach for content — SCORM, deliberately not the ilt session on the same source course.
const UC1_SOURCE_MODULE = 7788730;

function scenario1Meta() {
  return {
    use_case: 'uc1',
    name: 'Customer Onboarding Health',
    owner_name: 'Nik',
    owner_email: '',
    notes: 'In-flight accounts behind on required training, plus an established cohort that proves the correlation.'
  };
}

/**
 * The headline numbers this scenario is aiming for. Verify shows these next to what the portal
 * actually holds, so drift is visible without anyone having to remember the intent.
 */
function scenario1Expected() {
  return {
    accounts: {
      alderfield: { completion: 25, note: 'the at-risk account, heavily overdue' },
      copperlane: { completion: 62, note: 'recoverable but slipping' },
      vantageridge: { completion: 89, note: 'on track' },
      cobaltpeak: { completion: 100 }, fernpath: { completion: 100 },
      harborline: { completion: 100 }, halden: { completion: 100 },
      larkspur: { completion: 100 }, northwind: { completion: 100 }
    },
    notes: [
      'Trained early: Cobalt Peak 31, Fernpath 35, Harborline 36 days to go-live -> mean 34',
      'Lagged: Halden 62, Larkspur 74, Northwind 89 -> mean 75. A 41-day, 54% difference.'
    ]
  };
}

function loadScenario1() {
  loadScenarioData_(scenario1Meta(), {
    Accounts: scenario1Accounts_,
    People: scenario1People_,
    Courses: scenario1Courses_,
    Enrollments: scenario1Enrollments_,
    PersonaStates: scenario1PersonaStates_,
    TicketCategories: scenario1Categories_,
    Tickets: scenario1Tickets_,
    Deals: scenario1Deals_
  });
}

// ---------------------------------------------------------------------------

function scenario1Accounts_() {
  // account_key, use_case, company, domain, industry, cohort, tier, arr, S, G, A,
  // users, admins, target, [actual ƒ], csm, [group title ƒ], notes
  const rows = [
    ['alderfield', 'uc1', 'Alderfield Financial', 'alderfield-financial.com', 'Financial Services',
      'in_flight', 'Growth', 48000, 'T-68', 'T+12', '', 16, 4, 25, '', UC1_CSM_OWNER, '',
      'The at-risk account. Story 1 and Story 3 both hang off this one.'],
    ['copperlane', 'uc1', 'Copperlane Hospitality', 'copperlane.com', 'Hospitality',
      'in_flight', 'Growth', 36000, 'T-41', 'T+34', '', 12, 3, 62, '', UC1_CSM_OWNER, '',
      'Moderate risk — recoverable but slipping.'],
    ['vantageridge', 'uc1', 'Vantage Ridge Manufacturing', 'vantageridge.com', 'Manufacturing',
      'in_flight', 'Enterprise', 72000, 'T-26', 'T+29', '', 9, 3, 89, '', UC1_CSM_OWNER, '',
      'On track. The healthy contrast, and the reference band for the risk board.']
  ];

  UC1_ESTABLISHED.forEach(e => {
    const [key, company, domain, industry, tier, arr, start, coreDay, goLiveDay, users, admins] = e;
    const cohortNote = coreDay <= 30
      ? 'Trained early: core training done day ' + coreDay + ', live on day ' + goLiveDay + '.'
      : 'Lagged: core training not done until day ' + coreDay + ', live on day ' + goLiveDay + '.';
    rows.push([key, 'uc1', company, domain, industry, 'established', tier, arr, start,
      'S+' + goLiveDay, 'S+' + goLiveDay, users, admins, 100, '', UC1_CSM_OWNER, '', cohortNote]);
  });

  return rows;
}

function scenario1People_() {
  // person_key, use_case, first, last, [email ƒ], job_title, is_admin, account_key, notes
  return [
    ['alderfield.dana', 'uc1', 'Dana', 'Reyes', '', 'Platform Administrator', true, 'alderfield',
      'The critical blocker. Nobody else holds platform admin rights.'],
    ['alderfield.marcus', 'uc1', 'Marcus', 'Feld', '', 'IT Integrations Lead', true, 'alderfield',
      'Stalled 30% through Platform Setup.'],
    ['alderfield.tom', 'uc1', 'Tom', 'Whitlock', '', 'Compliance Officer', true, 'alderfield',
      'Has not started Getting Started.'],
    ['alderfield.priya', 'uc1', 'Priya', 'Raman', '', 'Operations Manager', false, 'alderfield',
      'The counter-example — finished her training.'],
    ['alderfield.helen', 'uc1', 'Helen', 'Cross', '', 'VP Operations', false, 'alderfield',
      'Project sponsor. The plausible recipient for the drafted intervention email.'],
    ['vantageridge.sofia', 'uc1', 'Sofia', 'Alvarez', '', 'Director of Operations', true, 'vantageridge',
      'Shows what a healthy admin team looks like.'],
    ['vantageridge.ben', 'uc1', 'Ben', 'Okoye', '', 'Systems Administrator', true, 'vantageridge',
      'Second healthy admin.']
  ];
}

function scenario1Courses_() {
  // course_key, use_case, title, [reference_code ƒ], source_module_id, notes
  return [
    ['nce-getting-started', 'uc1', 'Getting Started with ACME', '', UC1_SOURCE_MODULE,
      'Required for every user at an onboarding account.'],
    ['nce-admin-essentials', 'uc1', 'ACME Admin Essentials', '', UC1_SOURCE_MODULE, 'Administrators only.'],
    ['nce-platform-setup', 'uc1', 'Platform Setup & Configuration', '', UC1_SOURCE_MODULE, 'Administrators only.'],
    ['nce-launch-readiness', 'uc1', 'Launch Readiness Checkpoint', '', UC1_SOURCE_MODULE,
      'Administrators only. The empty row on the account card is the punchline of Story 3.']
  ];
}

function scenario1Enrollments_() {
  // row_id, use_case, account, course, audience, [count ƒ], completed, in_progress,
  // [not_started ƒ], due_offset, complete_offset, in_progress_pct, last_access_offset, notes
  const rows = [
    // Alderfield — 28 enrollments, 7 completed = 25%
    ['a1', 'uc1', 'alderfield', 'nce-getting-started', 'all', '', 6, 1, '',
      'G-40..G-5', 'S+12..S+55', '20..70', 'T-30..T-3', ''],
    ['a2', 'uc1', 'alderfield', 'nce-admin-essentials', 'admins', '', 1, 1, '',
      'G-30..G-18', 'S+30..S+50', '20..55', 'T-25..T-6', 'Dana has not started this one.'],
    ['a3', 'uc1', 'alderfield', 'nce-platform-setup', 'admins', '', 0, 1, '',
      'G-21..G-12', '', '25..40', 'T-24..T-18', 'Nobody has finished it.'],
    ['a4', 'uc1', 'alderfield', 'nce-launch-readiness', 'admins', '', 0, 0, '',
      'G-20..G-13', '', '', '',
      'Not one administrator has attempted it, and all four are overdue. Prerequisite for go-live sign-off.'],

    // Copperlane — 21 enrollments, 13 completed = 62%
    ['b1', 'uc1', 'copperlane', 'nce-getting-started', 'all', '', 9, 0, '',
      'G-55..G-25', 'S+5..S+38', '30..75', 'T-20..T-2', ''],
    ['b2', 'uc1', 'copperlane', 'nce-admin-essentials', 'admins', '', 2, 0, '',
      'G-50..G-30', 'S+10..S+34', '35..60', 'T-18..T-4', ''],
    ['b3', 'uc1', 'copperlane', 'nce-platform-setup', 'admins', '', 1, 0, '',
      'G-45..G-25', 'S+18..S+36', '20..50', 'T-16..T-3', ''],
    ['b4', 'uc1', 'copperlane', 'nce-launch-readiness', 'admins', '', 1, 0, '',
      'G-40..G-20', 'S+30..S+38', '', '',
      'Due dates sit early enough that slipping shows up as overdue, not just incomplete.'],

    // Vantage Ridge — 18 enrollments, 16 completed = 89%
    ['c1', 'uc1', 'vantageridge', 'nce-getting-started', 'all', '', 8, 0, '',
      'G-45..G-25', 'S+3..S+20', '55..85', 'T-9..T-2', ''],
    ['c2', 'uc1', 'vantageridge', 'nce-admin-essentials', 'admins', '', 3, 0, '',
      'G-40..G-22', 'S+8..S+22', '', '', ''],
    ['c3', 'uc1', 'vantageridge', 'nce-platform-setup', 'admins', '', 3, 0, '',
      'G-35..G-18', 'S+12..S+24', '', '', ''],
    ['c4', 'uc1', 'vantageridge', 'nce-launch-readiness', 'admins', '', 2, 0, '',
      'G-30..G-14', 'S+18..S+25', '60..80', 'T-8..T-3', 'One admin still working through it.']
  ];

  // Established cohort: everything complete, inside each account's own core-training window.
  UC1_ESTABLISHED.forEach(e => {
    const [key, , , , , , , coreDay, , users, admins] = e;
    const from = Math.max(2, Math.round(coreDay * 0.3));
    const window = 'S+' + from + '..S+' + coreDay;
    UC1_COURSE_KEYS.forEach((courseKey, i) => {
      const audience = i === 0 ? 'all' : 'admins';
      const count = i === 0 ? users : admins;
      rows.push([key + (i + 1), 'uc1', key, courseKey, audience, '', count, 0, '',
        'G-14..G-7', window, '', '',
        i === 0 ? 'Core training completed by day ' + coreDay + ' of onboarding.' : '']);
    });
  });

  return rows;
}

function scenario1PersonaStates_() {
  // row_id, use_case, person_key, course_key, status, percentage, complete_offset, last_access_offset, notes
  return [
    ['p01', 'uc1', 'alderfield.dana', 'nce-getting-started', 'completed', '', 'S+14', '', ''],
    ['p02', 'uc1', 'alderfield.dana', 'nce-admin-essentials', 'not_started', '', '', '',
      'The critical blocker: assigned, overdue, never opened.'],
    ['p03', 'uc1', 'alderfield.dana', 'nce-platform-setup', 'not_started', '', '', '', ''],
    ['p04', 'uc1', 'alderfield.dana', 'nce-launch-readiness', 'not_started', '', '', '', ''],

    ['p05', 'uc1', 'alderfield.marcus', 'nce-getting-started', 'completed', '', 'S+9', '', ''],
    ['p06', 'uc1', 'alderfield.marcus', 'nce-admin-essentials', 'completed', '', 'S+28', '', ''],
    ['p07', 'uc1', 'alderfield.marcus', 'nce-platform-setup', 'in_progress', 30, '', 'T-22',
      '30% through, stalled for 22 days. Needs spike 1 to be reproducible via the API.'],
    ['p08', 'uc1', 'alderfield.marcus', 'nce-launch-readiness', 'not_started', '', '', '', ''],

    ['p09', 'uc1', 'alderfield.tom', 'nce-getting-started', 'not_started', '', '', '', ''],
    ['p10', 'uc1', 'alderfield.tom', 'nce-admin-essentials', 'in_progress', 15, '', 'T-31', ''],
    ['p11', 'uc1', 'alderfield.tom', 'nce-platform-setup', 'not_started', '', '', '', ''],
    ['p12', 'uc1', 'alderfield.tom', 'nce-launch-readiness', 'not_started', '', '', '', ''],

    ['p13', 'uc1', 'alderfield.priya', 'nce-getting-started', 'completed', '', 'S+7', '',
      'The counter-example.'],
    ['p14', 'uc1', 'alderfield.helen', 'nce-getting-started', 'in_progress', 40, '', 'T-12', ''],

    ['p15', 'uc1', 'vantageridge.sofia', 'nce-getting-started', 'completed', '', 'S+5', '', ''],
    ['p16', 'uc1', 'vantageridge.sofia', 'nce-admin-essentials', 'completed', '', 'S+12', '', ''],
    ['p17', 'uc1', 'vantageridge.sofia', 'nce-platform-setup', 'completed', '', 'S+18', '', ''],
    ['p18', 'uc1', 'vantageridge.sofia', 'nce-launch-readiness', 'completed', '', 'S+22', '', ''],

    ['p19', 'uc1', 'vantageridge.ben', 'nce-getting-started', 'completed', '', 'S+6', '', ''],
    ['p20', 'uc1', 'vantageridge.ben', 'nce-admin-essentials', 'completed', '', 'S+14', '', ''],
    ['p21', 'uc1', 'vantageridge.ben', 'nce-platform-setup', 'completed', '', 'S+20', '', ''],
    ['p22', 'uc1', 'vantageridge.ben', 'nce-launch-readiness', 'completed', '', 'S+24', '', '']
  ];
}

function scenario1Categories_() {
  // category_key, label, course_key, is_deliberate_gap, notes
  // Only the deliberate gaps are listed now. The categories that DO have courses arrive with
  // scenario 2, when their courses exist.
  return [
    ['data-import', 'Data Import & Migration', '', true,
      'The load-bearing gap. In-flight accounts file tickets about it precisely because no training ' +
      'exists — that is the bridge between scenario 1 and scenario 2. Do not create a course for it.'],
    ['certification', 'Certification & Compliance', '', true, 'Content gap.'],
    ['billing', 'Billing & Subscription', '', true, 'Content gap.']
  ];
}

function scenario1Tickets_() {
  // Inert until HubSpot is connected. row_id, use_case, account, category, window_start,
  // window_end, count, contact_person_keys, priority, status, resolution_hours, notes
  return [
    ['t01', 'uc1', 'alderfield', 'data-import', 'S+20', 'T-1', 7,
      'alderfield.dana,alderfield.marcus', 'HIGH', 'open', 26,
      'Seven of eleven tickets. Diagnoses "stuck on migration", not "disengaged".'],
    ['t02', 'uc1', 'alderfield', 'certification', 'S+30', 'T-5', 2, 'alderfield.tom', 'MEDIUM', 'open', 40, ''],
    ['t03', 'uc1', 'alderfield', 'billing', 'S+40', 'T-8', 2, 'alderfield.helen', 'LOW', 'closed', 18, ''],
    ['t04', 'uc1', 'copperlane', 'data-import', 'S+10', 'T-2', 4, '', 'HIGH', 'open', 30, ''],
    ['t05', 'uc1', 'copperlane', 'billing', 'S+15', 'T-6', 2, '', 'LOW', 'closed', 20, ''],
    ['t06', 'uc1', 'vantageridge', 'data-import', 'S+8', 'T-4', 1, '', 'MEDIUM', 'closed', 12, ''],
    ['t07', 'uc1', 'vantageridge', 'certification', 'S+12', 'T-9', 1, '', 'LOW', 'closed', 22, '']
  ];
}

function scenario1Deals_() {
  // Inert until HubSpot is connected. The in-flight stages carry the deliberate contradiction:
  // Alderfield's project plan says UAT while its training data says nowhere near ready.
  const rows = [
    ['d01', 'uc1', 'alderfield', 'Onboarding', 'UAT', 48000, 'G', 'new',
      'Deliberately late-stage. The tension between UAT and 25% training complete IS the insight — ' +
      'if this sits in Training & Enablement there is no story.'],
    ['d02', 'uc1', 'copperlane', 'Onboarding', 'Data Migration', 36000, 'G', 'new', ''],
    ['d03', 'uc1', 'vantageridge', 'Onboarding', 'Training & Enablement', 72000, 'G', 'new', '']
  ];
  UC1_ESTABLISHED.forEach((e, i) => {
    rows.push(['d' + (10 + i), 'uc1', e[0], 'Onboarding', 'Go-Live', e[5], 'G', 'new',
      'Closed won. Go-live date must agree with actual_go_live_offset on the Accounts tab.']);
  });
  return rows;
}
