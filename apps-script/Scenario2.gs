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
 * RESOLVED 2026-08-10 — company names. The first draft reused five of uc1's accounts with different
 * headcounts and percentages, which validation refuses: company names become LearnUpon group titles
 * in one shared portal, and two "Northwind Logistics" groups with different completion rates would
 * make every demo answer ambiguous. These five accounts are uc2's own.
 *
 * Still portal-wide, and deliberately so: "top ticket categories over the last 90 days" counts
 * uc1's and uc3's tickets too. That is the honest answer to the question as a customer would ask it.
 */

const UC2_CSM_OWNER = 'michael.niemann@learnupon.com';
/**
 * Module donor for created courses.
 *
 * MODULE IDS ARE PORTAL-SPECIFIC. 7788730 exists in lucidchartsandbox and NOT in ACME, which is why
 * the first ACME seed produced three empty draft courses and 188 enrollment failures reading only
 * "internal error". This is the ACME id, the same one uc1's courses use there.
 *
 * The portable answer is Settings.default_source_module_id — when this id is not valid in whatever
 * portal you are pointed at, the seeder falls back to that and tells you it did. Never an
 * "ilt session": live sessions carry their own seat count and every enrollment fails.
 */
const UC2_SOURCE_MODULE = 7921958;

function scenario2Meta() {
  return {
    use_case: 'uc2',
    name: 'Knowledge Gaps vs Support Tickets',
    owner_name: 'Michael',
    owner_email: UC2_CSM_OWNER,
    notes: 'Ticket categories with no course are the content roadmap. Depends on the deliberate gaps staying empty.'
  };
}

/** Informative only. Verify prints these next to what the portal actually holds. */
function scenario2Expected() {
  return {
    accounts: {
      meridian:    { completion: 29, note: 'top target — highest tickets, lowest training' },
      calder:      { completion: 41 },
      thornbury:   { completion: 36 },
      silverbrook: { completion: 87, note: 'the proof account — completed the Masterclass' },
      aspenwood:   { completion: 92, note: 'contrast — fully trained and quiet' }
    },
    tickets: { recent_90_days: 92, prior_90_days: 125 },
    notes: [
      'Integrations tickets fall 38 -> 13 quarter over quarter',
      'The three categories with NO course are flat or rising; every category with a course falls',
      'The fall sits with the accounts that completed the Masterclass (silverbrook, aspenwood)',
      'Meridian enrolled NOBODY in the Masterclass and its integrations tickets are flat',
      'Data Import, Certification and Billing have no course — that is Story 1'
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
  //
  // All five are established: they went live long ago and are filing tickets now. An account
  // mid-onboarding could not have a year of ticket history to compare quarters against.
  return [
    ['meridian', 'uc2', 'Meridian Freight Systems', 'meridianfreight.com', 'Logistics and Supply Chain',
      'established', 'Growth', 42000, 'T-400', 'S+60', 'S+60', 14, 3, 29, '', UC2_CSM_OWNER, '',
      'Story 3 top target: most tickets, least training, and zero Masterclass enrolments.'],
    ['calder', 'uc2', 'Calder Retail Group', 'calderretail.com', 'Retail',
      'established', 'Growth', 55000, 'T-380', 'S+70', 'S+70', 22, 4, 41, '', UC2_CSM_OWNER, '',
      'Second target. Enrolled 14 of 22 in the Masterclass, so its integrations tickets fell partway.'],
    ['thornbury', 'uc2', 'Thornbury Energy', 'thornburyenergy.com', 'Oil & Energy',
      'established', 'Essentials', 28000, 'T-360', 'S+55', 'S+55', 11, 3, 36, '', UC2_CSM_OWNER, '',
      'Third target. Small Masterclass cohort, so only a small deflection.'],
    ['silverbrook', 'uc2', 'Silverbrook Health', 'silverbrookhealth.com', 'Hospital & Health Care',
      'established', 'Enterprise', 96000, 'T-420', 'S+65', 'S+65', 18, 4, 87, '', UC2_CSM_OWNER, '',
      'The proof account for Story 2: 16 of 18 took the Masterclass and integrations tickets collapsed.'],
    ['aspenwood', 'uc2', 'Aspenwood Software', 'aspenwoodsoftware.com', 'Computer Software',
      'established', 'Growth', 61000, 'T-390', 'S+50', 'S+50', 9, 3, 92, '', UC2_CSM_OWNER, '',
      'The contrast: fully trained, almost silent. Four tickets in ninety days.']
  ];
}

function scenario2People_() {
  // person_key, use_case, first_name, last_name, [email ƒ], job_title, is_admin, account_key, notes
  //
  // These are the ticket filers. The cross-system join is the email address and nothing else, so
  // every one of these people is also a LearnUpon user with the same address.
  return [
    ['meridian.dorsey', 'uc2', 'Rachel', 'Dorsey', '', 'Platform Administrator', true, 'meridian',
      'Files the most tickets of anyone in the dataset and has completed nothing.'],
    ['meridian.abara', 'uc2', 'Femi', 'Abara', '', 'Operations Manager', false, 'meridian', ''],
    ['meridian.klein', 'uc2', 'Daniel', 'Klein', '', 'IT Integrations Lead', true, 'meridian',
      'The person the Masterclass was written for. Never enrolled.'],

    ['calder.newport', 'uc2', 'Sasha', 'Newport', '', 'Systems Administrator', true, 'calder', ''],
    ['calder.iyer', 'uc2', 'Priya', 'Iyer', '', 'Retail Operations Lead', false, 'calder', ''],
    ['calder.brandt', 'uc2', 'Owen', 'Brandt', '', 'Data Analyst', false, 'calder', ''],

    ['thornbury.mackay', 'uc2', 'Elena', 'Mackay', '', 'Technical Administrator', true, 'thornbury', ''],
    ['thornbury.osei', 'uc2', 'Kwame', 'Osei', '', 'Compliance Manager', false, 'thornbury',
      'Files the certification tickets. There is no certification course, which is the point.'],
    ['thornbury.vance', 'uc2', 'Grace', 'Vance', '', 'Field Operations Coordinator', false, 'thornbury', ''],

    ['silverbrook.reid', 'uc2', 'Marcus', 'Reid', '', 'Platform Administrator', true, 'silverbrook', ''],
    ['silverbrook.tan', 'uc2', 'Wei', 'Tan', '', 'Clinical Systems Lead', false, 'silverbrook', ''],
    ['silverbrook.okafor', 'uc2', 'Ada', 'Okafor', '', 'Integrations Engineer', true, 'silverbrook',
      'Completed the Masterclass. Filed fourteen integrations tickets before it and two after.'],

    ['aspenwood.lindqvist', 'uc2', 'Johan', 'Lindqvist', '', 'Systems Administrator', true, 'aspenwood', ''],
    ['aspenwood.pereira', 'uc2', 'Sofia', 'Pereira', '', 'Product Operations Manager', false, 'aspenwood', ''],
    ['aspenwood.hughes', 'uc2', 'Tom', 'Hughes', '', 'Developer Relations Lead', false, 'aspenwood', '']
  ];
}

function scenario2Courses_() {
  // course_key, use_case, title, [reference_code ƒ], source_module_id, notes
  //
  // NEVER create a course for a deliberate gap category. Story 1 collapses if you do, and
  // validation blocks it.
  return [
    ['kb-reporting-analytics', 'uc2', 'Reporting and Analytics Essentials', '', UC2_SOURCE_MODULE,
      'Exists but barely enrolled — the "we built it and nobody took it" finding.'],
    ['kb-user-admin', 'uc2', 'User and Group Administration', '', UC2_SOURCE_MODULE, ''],
    ['kb-integrations', 'uc2', 'Integrations Masterclass', '', UC2_SOURCE_MODULE,
      'The Story 2 course. Completion wave sits at T-140..T-100, after which integrations tickets fall.']
  ];
}

/**
 * Enrolment and completion, per account per course.
 *
 * enroll_count_override is what makes this scenario expressible. "Meridian enrolled nobody in the
 * Masterclass" is a 0, and "Silverbrook enrolled 16 of its 18 people" is a 16 — neither can be
 * derived from a headcount, which is all the column offered before.
 *
 * The date chain is the whole of Story 2, in this order and with visible spacing:
 *   the Masterclass completion wave lands T-140..T-100
 *   integrations tickets fall in the window that starts at T-90
 * Do not close that gap. If completions overlap the ticket window the causal reading disappears.
 */
function scenario2Enrollments_() {
  // row_id, use_case, account_key, course_key, audience, enroll_count_override, [enroll_count ƒ],
  // completed_count, in_progress_count, [not_started_count ƒ], due_offset, complete_offset,
  // in_progress_pct, last_access_offset, notes
  const OLD_DUE = 'T-260..T-170';       // the two long-standing courses
  const OLD_DONE = 'T-300..T-180';
  const MC_DUE = 'T-130..T-70';         // the Masterclass
  const MC_DONE = 'T-140..T-100';

  return [
    // account, integrations enrolled/completed, reporting e/c, useradmin e/c
    ['m1', 'uc2', 'meridian', 'kb-integrations', 'all', 0, '', 0, 0, '', MC_DUE, MC_DONE, '', '',
      'Zero. This is the finding, not an omission — leave it at 0.'],
    ['m2', 'uc2', 'meridian', 'kb-reporting-analytics', 'all', 14, '', 4, 0, '', OLD_DUE, OLD_DONE, '', '', ''],
    ['m3', 'uc2', 'meridian', 'kb-user-admin', 'all', 14, '', 4, 0, '', OLD_DUE, OLD_DONE, '', '', ''],

    ['c1', 'uc2', 'calder', 'kb-integrations', 'all', 14, '', 11, 0, '', MC_DUE, MC_DONE, '', '', ''],
    ['c2', 'uc2', 'calder', 'kb-reporting-analytics', 'all', 22, '', 7, 0, '', OLD_DUE, OLD_DONE, '', '', ''],
    ['c3', 'uc2', 'calder', 'kb-user-admin', 'all', 22, '', 6, 0, '', OLD_DUE, OLD_DONE, '', '', ''],

    ['t1', 'uc2', 'thornbury', 'kb-integrations', 'all', 3, '', 2, 0, '', MC_DUE, MC_DONE, '', '', ''],
    ['t2', 'uc2', 'thornbury', 'kb-reporting-analytics', 'all', 11, '', 4, 0, '', OLD_DUE, OLD_DONE, '', '', ''],
    ['t3', 'uc2', 'thornbury', 'kb-user-admin', 'all', 11, '', 3, 0, '', OLD_DUE, OLD_DONE, '', '', ''],

    ['s1', 'uc2', 'silverbrook', 'kb-integrations', 'all', 16, '', 12, 0, '', MC_DUE, MC_DONE, '', '',
      '16 of 18. The Story 2 proof case.'],
    ['s2', 'uc2', 'silverbrook', 'kb-reporting-analytics', 'all', 18, '', 17, 0, '', OLD_DUE, OLD_DONE, '', '', ''],
    ['s3', 'uc2', 'silverbrook', 'kb-user-admin', 'all', 18, '', 16, 0, '', OLD_DUE, OLD_DONE, '', '', ''],

    ['a1', 'uc2', 'aspenwood', 'kb-integrations', 'all', 9, '', 9, 0, '', MC_DUE, MC_DONE, '', '', ''],
    ['a2', 'uc2', 'aspenwood', 'kb-reporting-analytics', 'all', 8, '', 7, 0, '', OLD_DUE, OLD_DONE, '', '', ''],
    ['a3', 'uc2', 'aspenwood', 'kb-user-admin', 'all', 8, '', 7, 0, '', OLD_DUE, OLD_DONE, '', '', '']
  ];
}

function scenario2PersonaStates_() {
  // row_id, use_case, person_key, course_key, status, percentage, complete_offset,
  // last_access_offset, notes
  //
  // in_progress cannot be created by the API — each one is a manual click in the portal UI after
  // seeding. Preview lists them under MANUAL STEP. Keep the count small.
  return [
    ['ps1', 'uc2', 'silverbrook.okafor', 'kb-integrations', 'completed', '', 'T-132', '',
      'Named in Story 2: her integrations tickets stop after this date.'],
    ['ps2', 'uc2', 'meridian.klein', 'kb-reporting-analytics', 'not_started', '', '', '',
      'The IT Integrations Lead who never trained. Story 3 names him.'],
    ['ps3', 'uc2', 'meridian.dorsey', 'kb-user-admin', 'not_started', '', '', '',
      'Files the most tickets in the dataset and has completed nothing.']
  ];
}

function scenario2Categories_() {
  // category_key, label, course_key, is_deliberate_gap, subject_templates, notes
  //
  // ONE taxonomy shared by all three scenarios; Load merges by category_key rather than replacing.
  // The three gaps are load-bearing: Story 1 IS "these categories have no training".
  //
  // subject_templates appear verbatim in demo answers. Write them the way a customer would.
  return [
    ['data-import', 'Data Import & Migration', '', true,
      'CSV import failing with no error message|How do I migrate historical records?|Bulk upload times out at 5000 rows|Duplicate records created after import|Import mapping does not save|Need help migrating from our old system|Import completed but records are missing',
      'The top category and the clearest content gap. Affects every account. Do not create a course for it.'],
    ['certification', 'Certification & Compliance', '', true,
      'How do I prove completion for our audit?|Certificate not issued after passing|Need compliance report for regulator|Can we set recurring recertification?|Certificate shows the wrong date|Where is the audit trail for training?',
      'Second gap. Growing quarter on quarter.'],
    ['billing', 'Billing & Subscription', '', true,
      'Invoice does not match our seat count|How do I add seats mid-term?|Request a copy of last quarter invoice|Change billing contact',
      'Third gap, lower volume.'],
    ['reporting', 'Reporting & Analytics', 'kb-reporting-analytics', false,
      'Cannot filter a report by group|Scheduled report never arrived|Export shows fewer rows than the screen|How do I report on completion by team?|Dashboard numbers do not match the report',
      'Course exists but enrolment is low — the "course exists, nobody took it" finding.'],
    ['user-management', 'User Management', 'kb-user-admin', false,
      'How do I bulk deactivate leavers?|User cannot log in after being added|Change a user from learner to admin|Group membership not applying|How do I merge two user accounts?',
      'Covered by User & Group Administration.'],
    ['integrations', 'Integrations', 'kb-integrations', false,
      'API returning 401 after key rotation|Webhook not firing on completion|SSO login loops back to sign-in|How do I sync users from our HR system?|Integration stopped syncing overnight|Need help with the API rate limits',
      'Covered by the Integrations Masterclass. This is the Story 2 deflection case.']
  ];
}

/**
 * Ticket volume, per account per category, in two 90-day windows.
 *
 * The two windows are the entire comparison Story 2 rests on. Integrations falls 38 -> 13, and the
 * fall sits with the accounts that completed the Masterclass. Everything else stays roughly flat,
 * so the drop cannot be explained by "they filed fewer tickets overall".
 *
 * Read down the integrations column: silverbrook 14 -> 2 and aspenwood 6 -> 1 (both trained),
 * against meridian 5 -> 5 (trained nobody).
 */
const UC2_TICKETS = {
  //                    meridian, calder, thornbury, silverbrook, aspenwood
  recent: {
    'data-import':      [9, 7, 5, 2, 1],
    'reporting':        [8, 6, 3, 2, 0],
    'certification':    [6, 5, 3, 1, 1],
    'user-management':  [4, 4, 3, 1, 1],
    'integrations':     [5, 3, 2, 2, 1],
    'billing':          [2, 2, 2, 1, 0]
  },
  prior: {
    'data-import':      [8, 6, 4, 3, 1],
    'reporting':        [9, 7, 4, 3, 1],
    'certification':    [5, 4, 3, 1, 1],
    'user-management':  [7, 6, 4, 3, 1],
    'integrations':     [5, 9, 4, 14, 6],
    'billing':          [2, 2, 1, 1, 0]
  }
};

const UC2_TICKET_ACCOUNTS = ['meridian', 'calder', 'thornbury', 'silverbrook', 'aspenwood'];

/** Filers, in the order tickets rotate through them. */
const UC2_TICKET_FILERS = {
  meridian:    'meridian.dorsey,meridian.klein,meridian.abara',
  calder:      'calder.newport,calder.brandt,calder.iyer',
  thornbury:   'thornbury.mackay,thornbury.osei,thornbury.vance',
  silverbrook: 'silverbrook.okafor,silverbrook.reid,silverbrook.tan',
  aspenwood:   'aspenwood.lindqvist,aspenwood.hughes,aspenwood.pereira'
};

/**
 * Resolution time by category — the quiet second finding.
 * The three categories with no course are also the three slowest to resolve, because there is
 * nothing to point a customer at.
 */
const UC2_RESOLUTION_HOURS = {
  'data-import': 48, 'certification': 36, 'billing': 20,
  'reporting': 12, 'user-management': 8, 'integrations': 10
};

const UC2_PRIORITY = {
  'data-import': 'HIGH', 'certification': 'HIGH', 'billing': 'LOW',
  'reporting': 'MEDIUM', 'user-management': 'MEDIUM', 'integrations': 'MEDIUM'
};

function scenario2Tickets_() {
  // row_id, use_case, account_key, category_key, window_start, window_end, count,
  // contact_person_keys, priority, status, resolution_hours, notes
  const rows = [];
  const windows = [
    { key: 'recent', start: 'T-90', end: 'T-1' },
    { key: 'prior', start: 'T-180', end: 'T-91' }
  ];

  windows.forEach(w => {
    Object.keys(UC2_TICKETS[w.key]).forEach(cat => {
      UC2_TICKETS[w.key][cat].forEach((count, i) => {
        if (!count) return;
        const acct = UC2_TICKET_ACCOUNTS[i];
        // Historic tickets are all closed. In the current window the gap category stays open,
        // because there is no course to deflect it and no self-serve answer to close it with.
        const status = (w.key === 'recent' && cat === 'data-import') ? 'Waiting on us' : 'Closed';
        rows.push([
          w.key.charAt(0) + '-' + cat + '-' + acct, 'uc2', acct, cat, w.start, w.end, count,
          UC2_TICKET_FILERS[acct], UC2_PRIORITY[cat], status, UC2_RESOLUTION_HOURS[cat], ''
        ]);
      });
    });
  });
  return rows;
}

function scenario2Deals_() {
  // row_id, use_case, account_key, pipeline, stage, amount, close_offset, deal_type, notes
  //
  // One deal, and it is there to give Story 3 a number. "The account with the most tickets and the
  // least training has a 42k renewal 75 days out" is a sharper close than a training statistic.
  return [
    ['d1', 'uc2', 'meridian', 'Sales Pipeline', 'Qualified To Buy', 42000, 'T+75', 'renewal',
      'The renewal at risk. Story 3 lands on this number.']
  ];
}
