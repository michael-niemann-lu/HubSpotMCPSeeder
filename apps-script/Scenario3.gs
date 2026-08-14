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
 * THREE STORIES, THIRTEEN ACCOUNTS, FOUR COURSES:
 *
 *   Group A — renewal risk, 8 accounts (Story 1)
 *     A renewal date plus a required-training percentage, now blended across TWO courses:
 *     Customer Success Platform Fundamentals (everyone) and Renewal Readiness: Admin Playbook
 *     (admins only). Scoring admins separately sharpens the story — an account can look adequate
 *     on the general course while its actual platform relationship-holders (the admins) are the
 *     ones who've gone quiet, which is a sharper finding than one blended number alone.
 *       bramwell, thackeray, delgado and fairholt sit below 50% ("gone quiet") — flag-worthy.
 *       corvallis, whitlock and osgood do not, so "pull accounts with a renewal in 60 days" doesn't
 *       return an all-red list. vantree is the DELIBERATE CONTROL: its completion (7%) is the worst
 *       of the whole scenario, but its renewal is 95 days out — outside the window — so a correct
 *       discovery query must exclude it. If it shows up in a "next 60 days" answer, the query is
 *       filtering on training alone and ignoring the renewal date.
 *     Ranking the four flagged accounts by ARR: bramwell 58k > delgado 51k > thackeray 46k > fairholt 39k.
 *     delgado is the "contradicts the deal stage" example Story 1's drill-down asks for: 48% required
 *     training (borderline flagged) but its deal already sits at Negotiation — the same shape as uc1's
 *     Alderfield/UAT tension. Every other Group A account's deal stage roughly tracks its training
 *     level, so this is the one deliberate mismatch to reach for.
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
 *     renew soon (all 100+ days out — each now has its own real renewal-type deal on the Sales
 *     Pipeline, so that fact is backed by data, not just a comment), so they never enter Group A's
 *     60-day pool — expansion and
 *     renewal risk stay legible as separate signals even though they share one sheet.
 *
 *     NOTE on calloway specifically: it is already Enterprise-tier — the top tier — so its opportunity
 *     is licenses-only ("22 active users against N licensed seats"), not a tier-upgrade pitch. The
 *     other four (Growth/Growth/Growth/Essentials) can support either angle. Don't build a "move them
 *     to the next tier" pitch for calloway; there isn't a tier above the one they're on.
 *
 *     A THIRD course, Elite Platform Certification, sits above Advanced: only calloway, praxis and
 *     brightwell — the three largest/most-progressed accounts — have anyone on it (exactly one
 *     person each, their sponsor/champion). This is the maturity ladder Story 2's "shortlist" can
 *     use to distinguish "certified" from "certified AND already advocating internally," and it's
 *     why calloway (the biggest gap, no deal) also has the strongest individual signal available.
 *
 *   Story 3 (One-Screen Health View) draws on Groups A and B directly. corvallis (healthy, quiet on
 *   support) against bramwell (at-risk, noisy on support) is the built-in side-by-side; the full
 *   13-account roster is what a "priority order this week" query ranks.
 *
 * PERSONA STATE PINS (scenario3PersonaStates_) put four named individuals into an in_progress state
 * that a bulk enrollment row cannot produce (spike 1b: the API can only create completed / not
 * started). Each is a MANUAL STEP — a one-time click in the portal UI after seeding; Preview lists
 * them so nobody mistakes them for already-done. They exist to give the Story 1/2 drill-down prompts
 * an individual, not just an account-level percentage, to talk about:
 *   bramwell.derek    stalled at 15%, last active 45 days ago — tried once, gave up
 *   delgado.marcus    60% through, active 9 days ago — a live nudge opportunity before a 20-day renewal
 *   calloway.jonas    45% through the Advanced cert, active 6 days ago — mid-certification right now
 *   vantree.liam      10%, last active 70 days ago — reinforces the control account's disengagement
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
    notes: 'Renewal risk surfaced early by training engagement (scored across a general course and ' +
      'an admin-only one), plus certification completions — up to an Elite tier for the most ' +
      'progressed accounts — that self-identify expansion-ready accounts.'
  };
}

/** Informative only. Verify prints these next to what the portal actually holds. */
function scenario3Expected() {
  return {
    accounts: {
      // Group A — renewal risk. Completion is now blended across Core Fundamentals + Admin Playbook.
      bramwell: { completion: 18,
        note: 'flagged — largest ARR among the flagged accounts, quiet 90+ days, renews in 42 days. ' +
          'Admins (0 of 4 on the Admin Playbook) are worse than the account average.' },
      thackeray: { completion: 35, note: 'flagged, mid ARR, renews in 55 days' },
      delgado: { completion: 48,
        note: 'flagged, borderline under 50%, renews in 20 days (soonest). Deal already at Negotiation ' +
          '— the deliberate "training contradicts deal stage" example for Story 1\'s drill-down.' },
      fairholt: { completion: 32, note: 'flagged, smallest ARR of the flagged group, renews in 48 days' },
      corvallis: { completion: 90,
        note: 'healthy contrast — largest ARR overall, renews in 30 days, all 5 admins Playbook-complete' },
      whitlock: { completion: 65, note: 'moderate, smallest ARR of Group A, renews in 58 days' },
      osgood: { completion: 56, note: 'moderate, large ARR, renews in 15 days — soon but not at risk' },
      vantree: { completion: 7,
        note: 'CONTROL — worst completion in the scenario, but renews in 95 days, OUTSIDE the 60-day ' +
          'window. Must not appear in a correctly-filtered "renewal in 60 days" answer.' },
      // Group B — expansion trigger. Completion blends Core Fundamentals + Advanced (+ Elite where held).
      calloway: { completion: 80,
        note: '22 of 30 seats Advanced-certified in the last 30 days — the biggest cohort — plus one ' +
          'Elite-certified sponsor, and still NO expansion deal exists. Already Enterprise-tier: pitch ' +
          'is licenses-only, not a tier upgrade.' },
      praxis: { completion: 73,
        note: '15 of 24 seats certified, one Elite-certified sponsor, Expansion deal open at Discovery' },
      fenwick: { completion: 71, note: '9 of 14 seats certified, NO expansion deal yet, no Elite tier yet' },
      brightwell: { completion: 71,
        note: '6 of 10 seats certified plus one Elite-certified lead, Expansion deal open at Proposal Sent' },
      nettlecombe: { completion: 56, note: '4 of 8 seats certified — modest, deliberately borderline, no deal' }
    },
    notes: [
      'Story 1 — accounts renewing within 60 days, ranked by ARR among those under 50%: ' +
        'bramwell 58k > delgado 51k > thackeray 46k > fairholt 39k. vantree must NOT appear (renews in 95 days).',
      'Story 1 drill-down heroes (PersonaStates, need a manual UI click after seeding): ' +
        'bramwell.derek stalled at 15%; delgado.marcus at 60% and recently active, a live nudge before renewal.',
      'Story 1 "contradicts the deal stage" example: delgado at 48% (borderline flagged) has a deal ' +
        'already at Negotiation — training says not ready, the deal stage says otherwise.',
      'Story 2 — ranked by certified headcount: calloway 22 > praxis 15 > fenwick 9 > brightwell 6 > ' +
        'nettlecombe 4. 3 of 5 (calloway, fenwick, nettlecombe) have no deal despite the signal. ' +
        'calloway, praxis and brightwell additionally have one Elite-certified sponsor each — the maturity ladder.',
      'Story 2 drill-down hero: calloway.jonas is mid-certification right now (45%, active 6 days ago) ' +
        'at the account with the biggest unaddressed signal.',
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
      'established', 'Growth', 58000, 'T-500', 'S+60', 'S+60', 18, 4, 18, '', UC3_CSM_OWNER, '',
      'Flagship at-risk account. Renewal in 42 days, quiet for 90+ days, largest ARR among the flagged accounts.'],
    ['thackeray', 'uc3', 'Thackeray Insurance Group', 'thackerayinsurance.com', 'Insurance',
      'established', 'Growth', 46000, 'T-480', 'S+60', 'S+60', 16, 4, 35, '', UC3_CSM_OWNER, '',
      'Renewal in 55 days, flagged (under 50%).'],
    ['delgado', 'uc3', 'Delgado Manufacturing', 'delgadomfg.com', 'Manufacturing',
      'established', 'Growth', 51000, 'T-520', 'S+60', 'S+60', 17, 4, 48, '', UC3_CSM_OWNER, '',
      'Renewal in 20 days — soonest of the group — and borderline flagged just under 50%.'],
    ['fairholt', 'uc3', 'Fairholt Logistics', 'fairholtlogistics.com', 'Freight & Logistics',
      'established', 'Growth', 39000, 'T-460', 'S+60', 'S+60', 15, 4, 32, '', UC3_CSM_OWNER, '',
      'Renewal in 48 days, flagged. Smallest ARR of the flagged group, so it ranks last on the ' +
      '"biggest at-risk deals" list even though it is just as disengaged.'],
    ['corvallis', 'uc3', 'Corvallis Health Systems', 'corvallishealth.com', 'Healthcare',
      'established', 'Enterprise', 88000, 'T-600', 'S+60', 'S+60', 25, 5, 90, '', UC3_CSM_OWNER, '',
      'Healthy contrast. Renewal in 30 days, largest ARR overall, not flagged, quiet on support too — ' +
      'the Story 3 comparison partner for bramwell. All 5 admins have completed the Admin Playbook.'],
    ['whitlock', 'uc3', 'Whitlock Retail Co', 'whitlockretail.com', 'Retail',
      'established', 'Essentials', 28000, 'T-450', 'S+60', 'S+60', 14, 3, 65, '', UC3_CSM_OWNER, '',
      'Renewal in 58 days, moderate engagement, smallest ARR in Group A, not flagged.'],
    ['osgood', 'uc3', 'Osgood Telecom', 'osgoodtelecom.com', 'Telecommunications',
      'established', 'Enterprise', 67000, 'T-430', 'S+60', 'S+60', 20, 5, 56, '', UC3_CSM_OWNER, '',
      'Renewal in 15 days — the soonest of anyone — but moderate engagement, not flagged. Shows a ' +
      'near-term renewal is not automatically a risk signal.'],
    ['vantree', 'uc3', 'Vantree Media', 'vantreemedia.com', 'Media & Entertainment',
      'established', 'Growth', 33000, 'T-380', 'S+60', 'S+60', 12, 3, 7, '', UC3_CSM_OWNER, '',
      'THE CONTROL ACCOUNT. Worst completion in the whole scenario (7%), but renews in 95 days — ' +
      'outside the 60-day window. A correct "renewing in the next 60 days" answer excludes it; if an ' +
      'assistant includes it, it is filtering on training alone and ignoring the renewal date.'],

    // --- Group B: expansion trigger (Story 2) -----------------------------------------------
    ['calloway', 'uc3', 'Calloway Systems', 'callowaysystems.com', 'Industrial IoT',
      'established', 'Enterprise', 74000, 'T-570', 'S+60', 'S+60', 30, 6, 80, '', UC3_CSM_OWNER, '',
      'Largest certified cohort in the scenario (22 of 30 seats, last 30 days), plus one ' +
      'Elite-certified sponsor, and NO expansion deal exists — the single biggest missed opportunity ' +
      'in the dataset. Already Enterprise-tier (the top tier), so the pitch is licenses-only, not a ' +
      'tier upgrade. Renews in 150 days, well outside Group A\'s window (backed by its own renewal-type deal).'],
    ['praxis', 'uc3', 'Praxis Robotics', 'praxisrobotics.com', 'Robotics & Automation',
      'established', 'Growth', 62000, 'T-550', 'S+60', 'S+60', 24, 5, 73, '', UC3_CSM_OWNER, '',
      '15 of 24 seats Advanced-certified in the last 30 days, plus one Elite-certified sponsor. An ' +
      'Expansion deal is already open at Discovery. Renews in 120 days.'],
    ['fenwick', 'uc3', 'Fenwick Analytics', 'fenwickanalytics.io', 'Software',
      'established', 'Growth', 39000, 'T-400', 'S+60', 'S+60', 14, 3, 71, '', UC3_CSM_OWNER, '',
      '9 of 14 seats Advanced-certified in the last 30 days, but NO expansion deal exists yet, and no ' +
      'Elite-tier holder — the least-progressed of the three engaged Group B accounts. Renews in 135 days.'],
    ['brightwell', 'uc3', 'Brightwell Analytics', 'brightwellanalytics.com', 'Business Intelligence',
      'established', 'Growth', 44000, 'T-410', 'S+60', 'S+60', 10, 3, 71, '', UC3_CSM_OWNER, '',
      '6 of 10 seats certified in the last 30 days plus one Elite-certified lead. Its Expansion deal ' +
      'is already at Proposal Sent — further along than praxis\'s — showing the signal can arrive ' +
      'after the conversation has already started, not only before it. Renews in 130 days.'],
    ['nettlecombe', 'uc3', 'Nettlecombe Commerce', 'nettlecombecommerce.com', 'E-Commerce',
      'established', 'Essentials', 21000, 'T-360', 'S+60', 'S+60', 8, 2, 56, '', UC3_CSM_OWNER, '',
      'Only 4 of 8 seats certified — the smallest, most borderline case in Group B, deliberately ' +
      'included so a ranked shortlist has a clear bottom entry, not just a cliff after fenwick. No ' +
      'deal exists, no Elite tier. Renews in 110 days.']
  ];
}

function scenario3People_() {
  // person_key, use_case, first_name, last_name, [email ƒ], job_title, is_admin, account_key, notes
  // Story 3 recommends named people to enrol, so each account needs at least three with real titles.
  return [
    // Bramwell — the flagship at-risk account
    ['bramwell.lena', 'uc3', 'Lena', 'Whitmore', '', 'IT Systems Manager', true, 'bramwell',
      'Hasn\'t logged in to LearnUpon in 60+ days.'],
    ['bramwell.derek', 'uc3', 'Derek', 'Okonkwo', '', 'Platform Administrator', true, 'bramwell',
      'Pinned in_progress (15%, last active 45 days ago) — started once, then went quiet. See PersonaStates.'],
    ['bramwell.sara', 'uc3', 'Sara', 'Lindqvist', '', 'Operations Director', false, 'bramwell',
      'The one person still engaging with training at all.'],

    // Thackeray
    ['thackeray.owen', 'uc3', 'Owen', 'Bright', '', 'IT Administrator', true, 'thackeray', ''],
    ['thackeray.nadia', 'uc3', 'Nadia', 'Fischer', '', 'Compliance Lead', true, 'thackeray', ''],
    ['thackeray.carl', 'uc3', 'Carl', 'Whitfield', '', 'Claims Operations Manager', false, 'thackeray', ''],

    // Delgado
    ['delgado.priya', 'uc3', 'Priya', 'Nathan', '', 'Systems Administrator', true, 'delgado', ''],
    ['delgado.marcus', 'uc3', 'Marcus', 'Boyle', '', 'Plant Operations Manager', true, 'delgado',
      'Pinned in_progress (60%, active 9 days ago) — close to finishing, 20 days before renewal. See PersonaStates.'],
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
    ['vantree.liam', 'uc3', 'Liam', 'Fitzgerald', '', 'Production Operations Manager', false, 'vantree',
      'Pinned in_progress (10%, last active 70 days ago). See PersonaStates.'],
    ['vantree.sofia', 'uc3', 'Sofia', 'Berger', '', 'Content Operations Lead', false, 'vantree', ''],

    // Calloway — the biggest expansion cohort, no deal. Priyanka is listed first, so she is the
    // one Elite Certification slot (enroll_count_override selects candidates in list order).
    ['calloway.priyanka', 'uc3', 'Priyanka', 'Suresh', '', 'Head of IT', true, 'calloway',
      'Advanced- and Elite-certified — the account\'s top credentialed user, despite no expansion ' +
      'deal existing yet.'],
    ['calloway.jonas', 'uc3', 'Jonas', 'Kessler', '', 'Systems Administrator', true, 'calloway',
      'Pinned in_progress on the Advanced cert (45%, active 6 days ago) — mid-certification right ' +
      'now, not yet one of the 22 completions. See PersonaStates for the pin driving Story 2\'s drill-down.'],
    ['calloway.maeve', 'uc3', 'Maeve', 'Doyle', '', 'Automation Program Lead', false, 'calloway',
      'Advanced-certified. Drove the certification push across the whole team — nobody has followed ' +
      'up commercially yet.'],

    // Praxis — the expansion account WITH a deal already open. Zara is listed first, so she holds
    // the one Elite Certification slot.
    ['praxis.zara', 'uc3', 'Zara', 'Khoury', '', 'Head of Platform Engineering', true, 'praxis',
      'Advanced- and Elite-certified. Sponsoring the push to certify the whole engineering group.'],
    ['praxis.milo', 'uc3', 'Milo', 'Andersen', '', 'Systems Administrator', true, 'praxis',
      'Advanced-certified.'],
    ['praxis.ines', 'uc3', 'Ines', 'Duarte', '', 'Automation Lead', false, 'praxis',
      'Advanced-certified. The internal champion driving adoption.'],

    // Fenwick — the original expansion account WITHOUT a deal yet, and no Elite tier
    ['fenwick.tariq', 'uc3', 'Tariq', 'Salim', '', 'Data Platform Lead', true, 'fenwick',
      'Advanced-certified.'],
    ['fenwick.chloe', 'uc3', 'Chloe', 'Bennett', '', 'Systems Administrator', true, 'fenwick',
      'Advanced-certified.'],
    ['fenwick.reid', 'uc3', 'Reid', 'Colston', '', 'Analytics Manager', false, 'fenwick',
      'Advanced-certified. Nobody has opened an expansion conversation despite this.'],

    // Brightwell — deal already further along than praxis's. Theo is listed first, so he holds the
    // one Elite Certification slot.
    ['brightwell.theo', 'uc3', 'Theo', 'Lindgren', '', 'Data Platform Lead', true, 'brightwell',
      'Advanced- and Elite-certified.'],
    ['brightwell.aisha', 'uc3', 'Aisha', 'Rahman', '', 'Systems Administrator', true, 'brightwell',
      'Advanced-certified.'],
    ['brightwell.connor', 'uc3', 'Connor', 'Blake', '', 'Analytics Operations Manager', false, 'brightwell',
      'Advanced-certified.'],

    // Nettlecombe — the modest, borderline case, no Elite tier
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
      'The baseline required course every uc3 account is measured against. Audience: all.'],
    ['uc3-admin-playbook', 'uc3', 'Renewal Readiness: Admin Playbook', '', UC3_SOURCE_MODULE,
      'Group A only (Story 1), admins-only. Scores the platform relationship-holders specifically — ' +
      'an account can look adequate on the general course while its admins have gone quiet, which is ' +
      'the sharper, more specific finding. Blends into required_complete_actual alongside the ' +
      'baseline course.'],
    ['uc3-advanced-cert', 'uc3', 'Advanced Platform Certification', '', UC3_SOURCE_MODULE,
      'Story 2\'s certification. Completions here, clustered in the last 30 days across Group B, are ' +
      'the expansion signal. Audience: all.'],
    ['uc3-elite-cert', 'uc3', 'Elite Platform Certification', '', UC3_SOURCE_MODULE,
      'Group B only, one seat per account (calloway, praxis, brightwell) via enroll_count_override. ' +
      'The tier above Advanced — held only by that account\'s sponsor/champion. Distinguishes ' +
      '"certified" from "certified and already advocating internally" for Story 2\'s ranked shortlist.']
  ];
}

function scenario3Enrollments_() {
  // row_id, use_case, account_key, course_key, audience, [enroll_count ƒ], completed_count,
  // in_progress_count, [not_started_count ƒ], due_offset, complete_offset, in_progress_pct,
  // last_access_offset, notes
  //
  // In-progress counts stay 0 everywhere below — the API can't bulk-create that state (spike 1b).
  // The four hero in_progress people come from scenario3PersonaStates_ pins instead, which override
  // specific named individuals without changing any row's completed_count.
  //
  // due_offset is in the FUTURE for the healthier accounts so their remaining incomplete learners are
  // not yet overdue; it's in the PAST for the at-risk group so "gone quiet" shows up as overdue, not
  // just incomplete. complete_offset is left blank where completed_count is 0 (not required — see
  // Validate.gs) rather than given a range that would never be used.
  return [
    // === Group A: Core Fundamentals (everyone) + Admin Playbook (admins only) ===============
    ['e01', 'uc3', 'bramwell', 'uc3-core-fundamentals', 'all', '', '', 4, 1, '',
      'T-90..T-30', 'T-160..T-100', 15, 'T-45',
      '4 of 18 = 22% on this course; blended with the Admin Playbook below. The 1 in_progress is ' +
      'the Derek Okonkwo pin (PersonaStates); pct/last-access repeated here only to satisfy the row.'],
    ['e19', 'uc3', 'bramwell', 'uc3-admin-playbook', 'admins', '', '', 0, 0, '',
      'T-70..T-20', '', '', '',
      '0 of 4 admins — worse than the account average. Blended: (4+0)/(18+4) = 18%.'],

    ['e02', 'uc3', 'thackeray', 'uc3-core-fundamentals', 'all', '', '', 6, 0, '',
      'T-75..T-20', 'T-150..T-90', '', '', '6 of 16 = 38% on this course; blended with the Admin Playbook below.'],
    ['e20', 'uc3', 'thackeray', 'uc3-admin-playbook', 'admins', '', '', 1, 0, '',
      'T-60..T-15', 'T-140..T-90', '', '', '1 of 4 admins. Blended: (6+1)/(16+4) = 35%.'],

    ['e03', 'uc3', 'delgado', 'uc3-core-fundamentals', 'all', '', '', 8, 1, '',
      'T-55..T-15', 'T-110..T-60', 60, 'T-9',
      '8 of 17 = 47% on this course; blended with the Admin Playbook below. The 1 in_progress is ' +
      'the Marcus Boyle pin (PersonaStates); pct/last-access repeated here only to satisfy the row.'],
    ['e21', 'uc3', 'delgado', 'uc3-admin-playbook', 'admins', '', '', 2, 0, '',
      'T-45..T-10', 'T-100..T-60', '', '', '2 of 4 admins. Blended: (8+2)/(17+4) = 48%.'],

    ['e10', 'uc3', 'fairholt', 'uc3-core-fundamentals', 'all', '', '', 5, 0, '',
      'T-80..T-25', 'T-170..T-110', '', '', '5 of 15 = 33% on this course; blended with the Admin Playbook below.'],
    ['e22', 'uc3', 'fairholt', 'uc3-admin-playbook', 'admins', '', '', 1, 0, '',
      'T-65..T-20', 'T-150..T-100', '', '', '1 of 4 admins. Blended: (5+1)/(15+4) = 32%.'],

    ['e04', 'uc3', 'corvallis', 'uc3-core-fundamentals', 'all', '', '', 22, 0, '',
      'T+15..T+35', 'T-200..T-60', '', '',
      '22 of 25 = 88% on this course; blended with the Admin Playbook below. Remaining three are not yet due.'],
    ['e23', 'uc3', 'corvallis', 'uc3-admin-playbook', 'admins', '', '', 5, 0, '',
      'T-90..T-60', 'T-150..T-40', '', '', 'All 5 admins done. Blended: (22+5)/(25+5) = 90%.'],

    ['e05', 'uc3', 'whitlock', 'uc3-core-fundamentals', 'all', '', '', 9, 0, '',
      'T+5..T+25', 'T-160..T-70', '', '', '9 of 14 = 64% on this course; blended with the Admin Playbook below.'],
    ['e24', 'uc3', 'whitlock', 'uc3-admin-playbook', 'admins', '', '', 2, 0, '',
      'T-40..T-10', 'T-130..T-60', '', '', '2 of 3 admins. Blended: (9+2)/(14+3) = 65%.'],

    ['e11', 'uc3', 'osgood', 'uc3-core-fundamentals', 'all', '', '', 11, 0, '',
      'T+5..T+20', 'T-140..T-50', '', '', '11 of 20 = 55% on this course; blended with the Admin Playbook below.'],
    ['e25', 'uc3', 'osgood', 'uc3-admin-playbook', 'admins', '', '', 3, 0, '',
      'T-35..T-10', 'T-120..T-50', '', '', '3 of 5 admins. Blended: (11+3)/(20+5) = 56%.'],

    ['e12', 'uc3', 'vantree', 'uc3-core-fundamentals', 'all', '', '', 1, 1, '',
      'T-100..T-40', 'T-200..T-150', 10, 'T-70',
      '1 of 12 = 8% on this course; blended with the Admin Playbook below — still the worst in the ' +
      'scenario. Renewal outside the 60-day window (T+95). The 1 in_progress is the Liam Fitzgerald ' +
      'pin (PersonaStates); pct/last-access repeated here only to satisfy the row.'],
    ['e26', 'uc3', 'vantree', 'uc3-admin-playbook', 'admins', '', '', 0, 0, '',
      'T-90..T-30', '', '', '', '0 of 3 admins. Blended: (1+0)/(12+3) = 7%.'],

    // === Group B: Core Fundamentals + Advanced Certification (+ Elite for the top three) ====
    ['e13', 'uc3', 'calloway', 'uc3-core-fundamentals', 'all', '', '', 26, 0, '',
      'T+20..T+40', 'T-220..T-80', '', '', '26 of 30 on the baseline course.'],
    ['e14', 'uc3', 'calloway', 'uc3-advanced-cert', 'all', '', '', 22, 1, '',
      'T-45..T-20', 'T-25..T-5', 45, 'T-6',
      '22 of 30 seats certified in the last 30 days. No deal. The 1 in_progress is the Jonas ' +
      'Kessler pin (PersonaStates) — mid-certification right now; pct/last-access repeated here ' +
      'only to satisfy the row.'],
    ['e27', 'uc3', 'calloway', 'uc3-elite-cert', 'all', 1, '', 1, 0, '',
      'T-20..T-10', 'T-15..T-5', '', '',
      'One seat — Priyanka, the account\'s Head of IT. Blended across all three: ' +
      '(26+22+1)/(30+30+1) = 80%.'],

    ['e06', 'uc3', 'praxis', 'uc3-core-fundamentals', 'all', '', '', 20, 0, '',
      'T+10..T+30', 'T-210..T-70', '', '', '20 of 24 on the baseline course.'],
    ['e08', 'uc3', 'praxis', 'uc3-advanced-cert', 'all', '', '', 15, 0, '',
      'T-45..T-20', 'T-25..T-5', '', '', '15 of 24 seats certified in the last 30 days.'],
    ['e28', 'uc3', 'praxis', 'uc3-elite-cert', 'all', 1, '', 1, 0, '',
      'T-20..T-10', 'T-15..T-5', '', '',
      'One seat — Zara, the sponsoring executive. Blended across all three: (20+15+1)/(24+24+1) = 73%.'],

    ['e07', 'uc3', 'fenwick', 'uc3-core-fundamentals', 'all', '', '', 11, 0, '',
      'T+10..T+30', 'T-190..T-60', '', '', '11 of 14 on the baseline course.'],
    ['e09', 'uc3', 'fenwick', 'uc3-advanced-cert', 'all', '', '', 9, 0, '',
      'T-45..T-20', 'T-25..T-5', '', '',
      '9 of 14 seats certified in the last 30 days. No Elite tier here — deliberately the least ' +
      'progressed of the three engaged accounts. Blended: (11+9)/(14+14) = 71%.'],

    ['e15', 'uc3', 'brightwell', 'uc3-core-fundamentals', 'all', '', '', 8, 0, '',
      'T+15..T+35', 'T-180..T-60', '', '', '8 of 10 on the baseline course.'],
    ['e16', 'uc3', 'brightwell', 'uc3-advanced-cert', 'all', '', '', 6, 0, '',
      'T-45..T-20', 'T-25..T-5', '', '', '6 of 10 seats certified in the last 30 days. Deal at Proposal Sent.'],
    ['e29', 'uc3', 'brightwell', 'uc3-elite-cert', 'all', 1, '', 1, 0, '',
      'T-20..T-10', 'T-15..T-5', '', '',
      'One seat — Theo, the Data Platform Lead. Blended across all three: (8+6+1)/(10+10+1) = 71%.'],

    ['e17', 'uc3', 'nettlecombe', 'uc3-core-fundamentals', 'all', '', '', 5, 0, '',
      'T+15..T+35', 'T-150..T-50', '', '', '5 of 8 on the baseline course.'],
    ['e18', 'uc3', 'nettlecombe', 'uc3-advanced-cert', 'all', '', '', 4, 0, '',
      'T-45..T-20', 'T-25..T-5', '', '',
      '4 of 8 seats certified in the last 30 days. Modest, no deal, no Elite tier. Blended: (5+4)/(8+8) = 56%.']
  ];
}

function scenario3PersonaStates_() {
  // row_id, use_case, person_key, course_key, status, percentage, complete_offset,
  // last_access_offset, notes
  //
  // in_progress cannot be created by the API — each one is a manual click in the portal UI after
  // seeding (spike 1b). Preview lists them under MANUAL STEP. Keep the count small: four, one per
  // hero moment across Stories 1 and 2. Pinning does not change any account's blended completion
  // percentage — it only converts one specific person's slot from not_started to in_progress, which
  // Expand.gs fills from the same unpinned pool either way.
  return [
    ['p01', 'uc3', 'bramwell.derek', 'uc3-core-fundamentals', 'in_progress', 15, '', 'T-45',
      'Started once, then went quiet — the "tried and gave up" data point for Story 1\'s drill-down ' +
      'on bramwell, which otherwise reads as pure silence.'],
    ['p02', 'uc3', 'delgado.marcus', 'uc3-core-fundamentals', 'in_progress', 60, '', 'T-9',
      'Close to finishing and recently active — a live nudge opportunity 20 days before delgado\'s renewal.'],
    ['p03', 'uc3', 'calloway.jonas', 'uc3-advanced-cert', 'in_progress', 45, '', 'T-6',
      'Mid-certification right now, at the account with the biggest expansion signal and no deal yet ' +
      '— Story 2\'s "this is happening today, not last quarter" drill-down.'],
    ['p04', 'uc3', 'vantree.liam', 'uc3-core-fundamentals', 'in_progress', 10, '', 'T-70',
      'One attempt, long abandoned — reinforces the control account\'s disengagement independent of ' +
      'its renewal timing.']
  ];
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
  //
  // `status` must be a REAL Support Pipeline stage label (New, Waiting on contact, Waiting on us,
  // Closed) — HubSpotSeed.gs uses this value verbatim as the stage to resolve, and refuses (not
  // defaults) anything that doesn't match. 'open' is not a stage and was a bug in an earlier draft;
  // match Michael's working uc2 convention of naming a real stage directly.
  return [
    // Group A
    ['t01', 'uc3', 'bramwell', 'data-import', 'T-90', 'T', 5, 'bramwell.lena,bramwell.derek',
      'HIGH', 'Waiting on us', 30, 'Migration-era issues resurfacing — nobody trained on it since.'],
    ['t02', 'uc3', 'bramwell', 'billing', 'T-90', 'T', 3, 'bramwell.sara', 'MEDIUM', 'Waiting on us', 20, ''],
    ['t03', 'uc3', 'thackeray', 'certification', 'T-90', 'T', 4, 'thackeray.nadia,thackeray.owen',
      'MEDIUM', 'Waiting on us', 24, ''],
    ['t04', 'uc3', 'thackeray', 'billing', 'T-90', 'T', 2, 'thackeray.carl', 'LOW', 'Closed', 14, ''],
    ['t05', 'uc3', 'delgado', 'integrations', 'T-90', 'T', 3, 'delgado.priya', 'MEDIUM', 'Waiting on us', 18, ''],
    ['t10', 'uc3', 'fairholt', 'data-import', 'T-90', 'T', 4, 'fairholt.talia,fairholt.dominic',
      'HIGH', 'Waiting on us', 28, 'Same migration-gap pattern as bramwell.'],
    ['t06', 'uc3', 'corvallis', 'reporting', 'T-90', 'T', 1, 'corvallis.wren', 'LOW', 'Closed', 8,
      'Healthy account — quiet on support too, the Story 3 contrast with bramwell.'],
    ['t07', 'uc3', 'whitlock', 'user-management', 'T-90', 'T', 2, 'whitlock.omar', 'LOW', 'Closed', 10, ''],
    ['t11', 'uc3', 'osgood', 'reporting', 'T-90', 'T', 2, 'osgood.ruth', 'MEDIUM', 'Waiting on us', 16, ''],
    ['t12', 'uc3', 'vantree', 'billing', 'T-90', 'T', 3, 'vantree.ana', 'MEDIUM', 'Waiting on us', 19,
      'Friction exists here too, but this account is excluded from Story 1 by renewal timing, not by health.'],

    // Group B
    ['t13', 'uc3', 'calloway', 'integrations', 'T-90', 'T', 1, 'calloway.jonas', 'LOW', 'Closed', 6,
      'Engaged account, minimal friction — consistent with a certified, expansion-ready customer.'],
    ['t08', 'uc3', 'praxis', 'integrations', 'T-90', 'T', 1, 'praxis.milo', 'LOW', 'Closed', 6,
      'Engaged account, minimal friction.'],
    ['t09', 'uc3', 'fenwick', 'reporting', 'T-90', 'T', 1, 'fenwick.chloe', 'LOW', 'Closed', 7, ''],
    ['t14', 'uc3', 'brightwell', 'reporting', 'T-90', 'T', 1, 'brightwell.aisha', 'LOW', 'Closed', 5, ''],
    ['t15', 'uc3', 'nettlecombe', 'user-management', 'T-90', 'T', 2, 'nettlecombe.oscar',
      'MEDIUM', 'Waiting on us', 12, '']
  ];
}

function scenario3Deals_() {
  // row_id, use_case, account_key, pipeline, stage, amount, close_offset, deal_type, notes
  //
  // PIPELINE: 'Sales Pipeline' — the default HubSpot pipeline confirmed to exist in the portal
  // (uc2's own working deal, meridian, uses it: see Scenario2.gs). There is no dedicated
  // Renewals/Expansion pipeline — HubSpot.gs's hsPipelineSpecs_() only creates 'Onboarding' (uc1's),
  // and deal seeding REFUSES a pipeline name it can't find rather than falling back to anything. An
  // earlier draft invented 'Renewals'/'Expansion' pipelines that don't exist anywhere; every deal
  // below now uses real Sales Pipeline stages, in their real order (earliest to latest):
  //   Appointment Scheduled < Qualified To Buy < Presentation Scheduled < Decision Maker Bought-In
  //     < Contract Sent < Closed Won / Closed Lost
  // Three story-relevant checkpoints are used, preserving that order: Discovery-equivalent =
  // 'Appointment Scheduled', proposal-equivalent = 'Presentation Scheduled', negotiation-equivalent
  // = 'Decision Maker Bought-In'. VERIFY against the live portal (Setup -> Show HubSpot Pipelines)
  // before seeding — default pipelines can be renamed per portal, and this is going on the
  // documented default plus uc2's proven-working example, not a live read.
  //
  // Group A: one deal per account. Group B: EVERY account now also gets a deal on this same pipeline
  // (added so the "renews in 100+ days" claim in each account's notes is backed by a real record, not
  // just prose) — all five sit at Appointment Scheduled, since 100+ days out is too early for
  // anything further along. `deal_type` (renewal/expansion) is the real signal distinguishing them,
  // written to HubSpot's native `dealtype` property — it does not require a separate pipeline.
  // calloway, fenwick and nettlecombe deliberately have only ONE deal each (deal_type 'renewal') and
  // nothing marked 'expansion' — that absence, against a real certification signal, is the Story 2
  // finding. praxis and brightwell carry two deals each: one 'renewal', one 'expansion'.
  return [
    ['d01', 'uc3', 'bramwell', 'Sales Pipeline', 'Appointment Scheduled', 58000, 'T+42', 'renewal',
      'Stalled at an early stage — matches the disengagement the training data already shows.'],
    ['d02', 'uc3', 'thackeray', 'Sales Pipeline', 'Presentation Scheduled', 46000, 'T+55', 'renewal', ''],
    ['d03', 'uc3', 'delgado', 'Sales Pipeline', 'Decision Maker Bought-In', 51000, 'T+20', 'renewal',
      'Already at Decision Maker Bought-In despite only 48% required training — the deal reads more ' +
      'confident than the training data supports. Story 1\'s "does the trend support or contradict ' +
      'the deal stage" drill-down has a real answer here: it contradicts.'],
    ['d07', 'uc3', 'fairholt', 'Sales Pipeline', 'Appointment Scheduled', 39000, 'T+48', 'renewal', ''],
    ['d04', 'uc3', 'corvallis', 'Sales Pipeline', 'Decision Maker Bought-In', 88000, 'T+30', 'renewal',
      'Smooth renewal, consistent with the healthy training picture.'],
    ['d05', 'uc3', 'whitlock', 'Sales Pipeline', 'Presentation Scheduled', 28000, 'T+58', 'renewal', ''],
    ['d08', 'uc3', 'osgood', 'Sales Pipeline', 'Decision Maker Bought-In', 67000, 'T+15', 'renewal', ''],
    ['d09', 'uc3', 'vantree', 'Sales Pipeline', 'Appointment Scheduled', 33000, 'T+95', 'renewal',
      'The renewal that puts this account outside the 60-day window despite its training data.'],

    // Group B — a renewal-type deal on every account, all comfortably outside Group A's 60-day window.
    ['d11', 'uc3', 'calloway', 'Sales Pipeline', 'Appointment Scheduled', 74000, 'T+150', 'renewal',
      'The renewal itself is calm and far out — the certification-without-an-expansion-deal gap is the real story here.'],
    ['d12', 'uc3', 'praxis', 'Sales Pipeline', 'Appointment Scheduled', 62000, 'T+120', 'renewal', ''],
    ['d13', 'uc3', 'fenwick', 'Sales Pipeline', 'Appointment Scheduled', 39000, 'T+135', 'renewal', ''],
    ['d14', 'uc3', 'brightwell', 'Sales Pipeline', 'Appointment Scheduled', 44000, 'T+130', 'renewal', ''],
    ['d15', 'uc3', 'nettlecombe', 'Sales Pipeline', 'Appointment Scheduled', 21000, 'T+110', 'renewal', ''],

    // Group B — an expansion-type deal ONLY on praxis and brightwell. calloway, fenwick, nettlecombe
    // have none — that absence, against a real certification signal, IS the finding.
    ['d06', 'uc3', 'praxis', 'Sales Pipeline', 'Appointment Scheduled', 18000, 'T+60', 'expansion',
      'Opened on the back of the certification wave.'],
    ['d10', 'uc3', 'brightwell', 'Sales Pipeline', 'Presentation Scheduled', 15000, 'T+50', 'expansion',
      'Further along than praxis\'s — the conversation started before or alongside the certification wave.']
  ];
}
