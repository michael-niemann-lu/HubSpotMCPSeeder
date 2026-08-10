/**
 * Validate.gs — the hard gate. Seeding refuses to run while any error exists.
 *
 * Two classes of check:
 *   error   — the plan is wrong or would produce nonsense. Blocks everything.
 *   warning — the plan is legal but probably not what you meant, or it quietly breaks a story
 *             (an in-flight account with nothing overdue has no Story 1).
 */

function validateWorkbook(opts) {
  opts = opts || {};
  const issues = [];
  const add = (severity, tab, row, column, message) =>
    issues.push([severity, tab, row || '', column || '', message]);
  const err = (tab, row, col, msg) => add('error', tab, row, col, msg);
  const warn = (tab, row, col, msg) => add('warning', tab, row, col, msg);

  const wb = loadWorkbook();

  validateSettings_(wb, err, warn);
  const accountByKey = validateAccounts_(wb, err, warn);
  const courseByKey = validateCourses_(wb, err, warn);
  validatePeople_(wb, accountByKey, err, warn);
  validateEnrollments_(wb, accountByKey, courseByKey, err, warn);
  validatePersonaStates_(wb, accountByKey, courseByKey, err, warn);
  validateCategories_(wb, courseByKey, err, warn);
  validateCrossScenario_(wb, err, warn);

  // Story-level checks need the expanded plan, which is only meaningful once the structure is sound.
  const errorsSoFar = issues.filter(i => i[0] === 'error').length;
  if (errorsSoFar === 0) {
    try {
      const plan = expand(wb);
      plan.warnings.forEach(w => warn('(expansion)', '', '', w));
      if (plan.manualTouches.length) {
        warn(TAB.ENROLLMENTS, '', 'in_progress_count', plan.manualTouches.length +
          ' enrollment(s) are declared in progress. The API cannot create that state, so they will ' +
          'be seeded as not started and must be opened by hand in the portal. The full list is on ' +
          '_Preview after a dry run. Keep this number small.');
      }
      validateStats_(plan, accountByKey, err, warn);
    } catch (e) {
      err('(expansion)', '', '', 'Expansion failed: ' + e.message);
    }
  }

  writeValidation_(issues);

  const errors = issues.filter(i => i[0] === 'error').length;
  const warnings = issues.filter(i => i[0] === 'warning').length;

  if (!opts.silent) {
    const head = errors === 0
      ? (warnings === 0 ? 'Clean — no errors, no warnings.' : 'No errors. ' + warnings + ' warning(s).')
      : errors + ' error(s) and ' + warnings + ' warning(s). Seeding is blocked.';
    const sample = issues.slice(0, 15)
      .map(i => '[' + i[0] + '] ' + i[1] + (i[2] ? ' row ' + i[2] : '') +
        (i[3] ? ' · ' + i[3] : '') + '\n    ' + i[4]).join('\n');
    uiAlert('Validation', head + '\n\nFull results on the _Validation tab.\n\n' + sample +
      (issues.length > 15 ? '\n\n... and ' + (issues.length - 15) + ' more.' : ''));
  }

  return { errors: errors, warnings: warnings };
}

function writeValidation_(issues) {
  const at = nowIso();
  const order = { error: 0, warning: 1 };
  const rows = issues
    .slice()
    .sort((a, b) => (order[a[0]] - order[b[0]]) || String(a[1]).localeCompare(String(b[1])))
    .map(i => [at, i[0], i[1], i[2], i[3], i[4]]);
  replaceTabBody(TAB.VALIDATION, rows);
}

// ---------------------------------------------------------------------------

function validateSettings_(wb, err, warn) {
  const s = wb.settings;
  if (ENUM.ENVIRONMENT.indexOf(String(s.environment || '').trim()) === -1) {
    err(TAB.SETTINGS, '', 'environment', 'Must be one of: ' + ENUM.ENVIRONMENT.join(', '));
  }
  if (ENUM.ANCHOR_MODE.indexOf(String(s.t_anchor_mode || '').trim()) === -1) {
    err(TAB.SETTINGS, '', 't_anchor_mode', 'Must be one of: ' + ENUM.ANCHOR_MODE.join(', '));
  }
  if (String(s.t_anchor_mode).trim() === 'pinned') {
    try { coerceDate(s.t_anchor_date); }
    catch (e) { err(TAB.SETTINGS, '', 't_anchor_date', 'Anchor mode is pinned: ' + e.message); }
  }
  if (String(s.prng_seed || '').trim() === '') {
    err(TAB.SETTINGS, '', 'prng_seed', 'Must not be blank — it is what makes runs reproducible.');
  }
  ['job_title_field_label', 'demo_source_field_label'].forEach(k => {
    if (!String(s[k] || '').trim()) {
      warn(TAB.SETTINGS, '', k, 'Blank. Custom user fields are resolved by label at run time, so ' +
        'seeding will skip writing this field.');
    }
  });
}

function validateAccounts_(wb, err, warn) {
  const byKey = {};
  const T = (function () { try { return resolveAnchor(wb.settings); } catch (e) { return todayUtc(); } })();

  wb.accounts.forEach(a => {
    const r = a._row;
    if (!a.account_key) { err(TAB.ACCOUNTS, r, 'account_key', 'Required.'); return; }
    if (byKey[a.account_key]) {
      err(TAB.ACCOUNTS, r, 'account_key', 'Duplicate key "' + a.account_key + '" (also row ' +
        byKey[a.account_key]._row + ').');
      return;
    }
    byKey[a.account_key] = a;

    if (ENUM.USE_CASE.indexOf(String(a.use_case).trim()) === -1) {
      err(TAB.ACCOUNTS, r, 'use_case', 'Must be one of: ' + ENUM.USE_CASE.join(', '));
    }
    if (!String(a.company_name || '').trim()) err(TAB.ACCOUNTS, r, 'company_name', 'Required.');
    const domain = String(a.domain || '').trim();
    if (!domain) err(TAB.ACCOUNTS, r, 'domain', 'Required — filler learner emails are built from it.');
    else if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      err(TAB.ACCOUNTS, r, 'domain', 'Does not look like a bare domain: "' + domain + '".');
    }
    if (ENUM.COHORT.indexOf(String(a.cohort).trim()) === -1) {
      err(TAB.ACCOUNTS, r, 'cohort', 'Must be one of: ' + ENUM.COHORT.join(', '));
    }

    const users = num_(a.user_count, null);
    const admins = num_(a.admin_count, null);
    if (users === null || users <= 0) err(TAB.ACCOUNTS, r, 'user_count', 'Must be a positive number.');
    if (admins === null || admins < 0) err(TAB.ACCOUNTS, r, 'admin_count', 'Must be a number.');
    if (users !== null && admins !== null && admins > users) {
      err(TAB.ACCOUNTS, r, 'admin_count', 'admin_count (' + admins + ') exceeds user_count (' +
        users + '). Admins are counted within the total.');
    }

    try {
      const ctx = accountDateContext(a, T);
      if (!ctx.S) err(TAB.ACCOUNTS, r, 'onboarding_start_offset', 'Required — it defines S.');
      if (!ctx.G) err(TAB.ACCOUNTS, r, 'target_go_live_offset', 'Required — it defines G.');

      const cohort = String(a.cohort).trim();
      if (cohort === 'established' && !ctx.A) {
        warn(TAB.ACCOUNTS, r, 'actual_go_live_offset',
          'Established account with no actual go-live date. Story 2 compares time-to-launch, so this account cannot contribute.');
      }
      if (cohort === 'in_flight' && ctx.A) {
        warn(TAB.ACCOUNTS, r, 'actual_go_live_offset',
          'In-flight account has an actual go-live date. If it has launched, its cohort should be established.');
      }
      if (cohort === 'in_flight' && ctx.G && ctx.G.getTime() < T.getTime()) {
        warn(TAB.ACCOUNTS, r, 'target_go_live_offset',
          'Target go-live is in the past (' + ymd(ctx.G) + ') for an in-flight account.');
      }
      if (ctx.S && ctx.G && ctx.G.getTime() < ctx.S.getTime()) {
        err(TAB.ACCOUNTS, r, 'target_go_live_offset', 'Go-live (' + ymd(ctx.G) +
          ') is before onboarding start (' + ymd(ctx.S) + ').');
      }
    } catch (e) {
      err(TAB.ACCOUNTS, r, 'onboarding_start_offset / target_go_live_offset', e.message);
    }

    const target = num_(a.required_complete_target, null);
    if (target !== null && (target < 0 || target > 100)) {
      err(TAB.ACCOUNTS, r, 'required_complete_target', 'Must be a percentage between 0 and 100.');
    }
  });

  if (!wb.accounts.length) err(TAB.ACCOUNTS, '', '', 'No accounts. Try Setup -> Load Example Scenario (UC1).');
  return byKey;
}

function validateCourses_(wb, err, warn) {
  const byKey = {};
  const titles = {};
  wb.courses.forEach(c => {
    const r = c._row;
    if (!c.course_key) { err(TAB.COURSES, r, 'course_key', 'Required.'); return; }
    if (byKey[c.course_key]) {
      err(TAB.COURSES, r, 'course_key', 'Duplicate key "' + c.course_key + '".');
      return;
    }
    byKey[c.course_key] = c;

    if (ENUM.USE_CASE.indexOf(String(c.use_case).trim()) === -1) {
      err(TAB.COURSES, r, 'use_case', 'Must be one of: ' + ENUM.USE_CASE.join(', '));
    }
    const title = String(c.title || '').trim();
    if (!title) err(TAB.COURSES, r, 'title', 'Required — it appears verbatim in demo answers.');
    if (titles[title.toLowerCase()]) {
      err(TAB.COURSES, r, 'title', 'Duplicate title. Two identically named courses make demo answers ambiguous.');
    }
    titles[title.toLowerCase()] = true;
    if (title.indexOf("'") !== -1) {
      warn(TAB.COURSES, r, 'title', 'Contains an apostrophe, which has bitten LearnUpon POSTs before.');
    }
    if (title.length > 120) err(TAB.COURSES, r, 'title', 'Over 120 characters; LearnUpon will reject it.');

    if (num_(c.source_module_id, null) === null) {
      err(TAB.COURSES, r, 'source_module_id',
        'Required — the numeric id of a LearnUpon module to attach as this course\'s content. ' +
        'Must not be an "ilt session". Verify with Setup -> Check Course Source.');
    }
  });
  if (!wb.courses.length) err(TAB.COURSES, '', '', 'No courses.');
  return byKey;
}

function validatePeople_(wb, accountByKey, err, warn) {
  const keys = {};
  const emails = {};
  wb.people.forEach(p => {
    const r = p._row;
    if (!p.person_key) { err(TAB.PEOPLE, r, 'person_key', 'Required.'); return; }
    if (keys[p.person_key]) { err(TAB.PEOPLE, r, 'person_key', 'Duplicate key "' + p.person_key + '".'); return; }
    keys[p.person_key] = true;

    if (!String(p.first_name || '').trim()) err(TAB.PEOPLE, r, 'first_name', 'Required.');
    if (!String(p.last_name || '').trim()) err(TAB.PEOPLE, r, 'last_name', 'Required.');
    if (!p.account_key || !accountByKey[p.account_key]) {
      err(TAB.PEOPLE, r, 'account_key', 'Does not match any account: "' + p.account_key + '".');
    }
    if (!String(p.job_title || '').trim()) {
      warn(TAB.PEOPLE, r, 'job_title', 'Blank. Story 3 identifies administrators by job title, ' +
        'so a blank title makes this person invisible to that question.');
    }

    const email = String(p.email || '').trim().toLowerCase();
    if (!email) {
      err(TAB.PEOPLE, r, 'email', 'Blank. It is a computed column — run Setup -> Create / Repair Workbook.');
    } else if (email.indexOf('missing-account') !== -1) {
      err(TAB.PEOPLE, r, 'email', 'Resolves to MISSING-ACCOUNT, so account_key does not match a row ' +
        'with a domain. This would silently break the cross-system join.');
    } else if (emails[email]) {
      err(TAB.PEOPLE, r, 'email', 'Duplicate email "' + email + '" (also row ' + emails[email] + ').');
    }
    if (email) emails[email] = r;

    const acct = accountByKey[p.account_key];
    if (acct && String(acct.use_case).trim() !== String(p.use_case).trim()) {
      err(TAB.PEOPLE, r, 'use_case', 'Person is use_case ' + p.use_case + ' but account ' +
        p.account_key + ' is ' + acct.use_case + '.');
    }
  });
}

function validateEnrollments_(wb, accountByKey, courseByKey, err, warn) {
  const seen = {};
  const coursesUsed = {};
  const accountsUsed = {};

  wb.enrollments.forEach(row => {
    const r = row._row;
    const acct = accountByKey[row.account_key];
    const course = courseByKey[row.course_key];

    if (!row.account_key || !acct) {
      err(TAB.ENROLLMENTS, r, 'account_key', 'Does not match any account: "' + row.account_key + '".');
    }
    if (!row.course_key || !course) {
      err(TAB.ENROLLMENTS, r, 'course_key', 'Does not match any course: "' + row.course_key + '".');
    }
    if (ENUM.AUDIENCE.indexOf(String(row.audience).trim()) === -1) {
      err(TAB.ENROLLMENTS, r, 'audience', 'Must be one of: ' + ENUM.AUDIENCE.join(', '));
    }
    if (!acct || !course) return;

    accountsUsed[row.account_key] = true;
    coursesUsed[row.course_key] = true;

    const dupe = row.account_key + '|' + row.course_key + '|' + String(row.audience).trim();
    if (seen[dupe]) {
      err(TAB.ENROLLMENTS, r, 'course_key', 'Duplicate declaration for ' + row.account_key + ' / ' +
        row.course_key + ' / ' + row.audience + ' (also row ' + seen[dupe] + ').');
    }
    seen[dupe] = r;

    // The invariant the whole demo percentage rests on.
    if (String(course.use_case).trim() !== String(acct.use_case).trim()) {
      err(TAB.ENROLLMENTS, r, 'course_key', 'Course ' + row.course_key + ' is use_case ' +
        course.use_case + ' but account ' + row.account_key + ' is ' + acct.use_case +
        '. Enrolling a user outside their use case silently changes every percentage in the demo.');
    }

    const total = num_(row.enroll_count, null);
    const done = num_(row.completed_count, 0);
    const wip = num_(row.in_progress_count, 0);
    if (done < 0 || wip < 0) err(TAB.ENROLLMENTS, r, 'completed_count', 'Counts cannot be negative.');
    if (total !== null && done + wip > total) {
      err(TAB.ENROLLMENTS, r, 'completed_count',
        'completed (' + done + ') + in_progress (' + wip + ') exceeds enroll_count (' + total + ').');
    }
    const audienceCap = num_(String(row.audience).trim() === 'admins' ? acct.admin_count : acct.user_count, 0);
    if (total !== null && total > audienceCap) {
      err(TAB.ENROLLMENTS, r, 'enroll_count', 'Wants ' + total + ' but the account only has ' +
        audienceCap + ' ' + row.audience + '.');
    }

    let ctx = null;
    try { ctx = accountDateContext(acct, resolveAnchor(wb.settings)); } catch (e) { /* reported on Accounts */ }

    [['due_offset', row.due_offset, false],
     ['complete_offset', row.complete_offset, done > 0],
     ['last_access_offset', row.last_access_offset, false]
    ].forEach(([col, value, required]) => {
      if (!String(value || '').trim()) {
        if (required) {
          err(TAB.ENROLLMENTS, r, col, 'Required when completed_count is above zero.');
        }
        return;
      }
      try {
        const spec = parseOffsetSpec(value);
        if (ctx) {
          const a = resolveToken(spec.from, ctx);
          const b = resolveToken(spec.to, ctx);
          if (a.getTime() > b.getTime()) {
            err(TAB.ENROLLMENTS, r, col, 'Range runs backwards: ' + ymd(a) + ' .. ' + ymd(b) + '.');
          }
        }
      } catch (e) {
        err(TAB.ENROLLMENTS, r, col, e.message);
      }
    });

    if (wip > 0) {
      if (!String(row.in_progress_pct || '').trim()) {
        warn(TAB.ENROLLMENTS, r, 'in_progress_pct', 'Blank with ' + wip +
          ' in-progress enrollments — they will default to 25%.');
      }
      if (!String(row.last_access_offset || '').trim()) {
        warn(TAB.ENROLLMENTS, r, 'last_access_offset', 'Blank with ' + wip +
          ' in-progress enrollments, so none will show a stall date.');
      }
    }
    try { parseNumberSpec(row.in_progress_pct); }
    catch (e) { err(TAB.ENROLLMENTS, r, 'in_progress_pct', e.message); }

    if (!String(row.due_offset || '').trim()) {
      warn(TAB.ENROLLMENTS, r, 'due_offset', 'Blank, so nothing here can ever be overdue. ' +
        '"Behind on required training" means overdue, not merely incomplete.');
    }
  });

  wb.courses.forEach(c => {
    if (!coursesUsed[c.course_key]) {
      warn(TAB.COURSES, c._row, 'course_key', 'No enrollment declarations reference this course, ' +
        'so it will be created empty.');
    }
  });
  wb.accounts.forEach(a => {
    if (!accountsUsed[a.account_key]) {
      warn(TAB.ACCOUNTS, a._row, 'account_key', 'No enrollment declarations reference this account.');
    }
  });
}

function validatePersonaStates_(wb, accountByKey, courseByKey, err, warn) {
  const peopleByKey = {};
  wb.people.forEach(p => { if (p.person_key) peopleByKey[p.person_key] = p; });

  const declaredByAcctCourse = {};
  wb.enrollments.forEach(row => {
    declaredByAcctCourse[row.account_key + '|' + row.course_key] = row;
  });

  const seen = {};
  const pinnedCounts = {}; // acct|course -> {completed, in_progress}

  wb.personaStates.forEach(ps => {
    const r = ps._row;
    const person = peopleByKey[ps.person_key];
    if (!ps.person_key || !person) {
      err(TAB.PERSONA_STATES, r, 'person_key', 'Does not match any person: "' + ps.person_key + '".');
      return;
    }
    if (!ps.course_key || !courseByKey[ps.course_key]) {
      err(TAB.PERSONA_STATES, r, 'course_key', 'Does not match any course: "' + ps.course_key + '".');
      return;
    }
    const status = String(ps.status || '').trim();
    if (ENUM.STATUS.indexOf(status) === -1) {
      err(TAB.PERSONA_STATES, r, 'status', 'Must be one of: ' + ENUM.STATUS.join(', '));
      return;
    }

    const dupe = ps.person_key + '|' + ps.course_key;
    if (seen[dupe]) {
      err(TAB.PERSONA_STATES, r, 'person_key', 'This person already has a pin for ' + ps.course_key +
        ' on row ' + seen[dupe] + '.');
      return;
    }
    seen[dupe] = r;

    const declaration = declaredByAcctCourse[person.account_key + '|' + ps.course_key];
    if (!declaration) {
      warn(TAB.PERSONA_STATES, r, 'course_key', person.person_key + ' is pinned on ' + ps.course_key +
        ' but ' + person.account_key + ' has no enrollment declaration for that course, so the pin does nothing.');
      return;
    }
    if (String(declaration.audience).trim() === 'admins' && !truthy_(person.is_admin)) {
      err(TAB.PERSONA_STATES, r, 'person_key', person.person_key + ' is not an admin, but ' +
        ps.course_key + ' at ' + person.account_key + ' is enrolled to admins only.');
    }

    const bucket = pinnedCounts[declaration._row] = pinnedCounts[declaration._row] ||
      { completed: 0, in_progress: 0, not_started: 0 };
    bucket[status]++;

    if (status === 'in_progress') {
      const pct = num_(ps.percentage, null);
      if (pct === null) {
        warn(TAB.PERSONA_STATES, r, 'percentage', 'Blank for an in-progress pin; the declaration range will be used.');
      } else if (pct <= 0 || pct >= 100) {
        err(TAB.PERSONA_STATES, r, 'percentage', 'In-progress percentage must be between 1 and 99.');
      }
    }
    if (status === 'completed' && !String(ps.complete_offset || '').trim()) {
      warn(TAB.PERSONA_STATES, r, 'complete_offset', 'Blank for a completed pin; the declaration range will be used.');
    }
    ['complete_offset', 'last_access_offset'].forEach(col => {
      if (!String(ps[col] || '').trim()) return;
      try { parseOffsetSpec(ps[col]); } catch (e) { err(TAB.PERSONA_STATES, r, col, e.message); }
    });
  });

  Object.keys(pinnedCounts).forEach(rowNum => {
    const declaration = wb.enrollments.filter(e => String(e._row) === String(rowNum))[0];
    if (!declaration) return;
    const pinned = pinnedCounts[rowNum];
    const done = num_(declaration.completed_count, 0);
    const wip = num_(declaration.in_progress_count, 0);
    if (pinned.completed > done) {
      err(TAB.ENROLLMENTS, declaration._row, 'completed_count', pinned.completed +
        ' people are pinned completed on PersonaStates but this row only declares ' + done + '.');
    }
    if (pinned.in_progress > wip) {
      err(TAB.ENROLLMENTS, declaration._row, 'in_progress_count', pinned.in_progress +
        ' people are pinned in progress on PersonaStates but this row only declares ' + wip + '.');
    }
  });
}

function validateCategories_(wb, courseByKey, err, warn) {
  const keys = {};
  const courseTitles = wb.courses.map(c => String(c.title || '').toLowerCase());

  wb.ticketCategories.forEach(tc => {
    const r = tc._row;
    if (!tc.category_key) { err(TAB.TICKET_CATEGORIES, r, 'category_key', 'Required.'); return; }
    if (keys[tc.category_key]) {
      err(TAB.TICKET_CATEGORIES, r, 'category_key', 'Duplicate key "' + tc.category_key + '".');
      return;
    }
    keys[tc.category_key] = true;

    const gap = truthy_(tc.is_deliberate_gap);
    const label = String(tc.label || '').trim();
    if (!label) err(TAB.TICKET_CATEGORIES, r, 'label', 'Required.');

    if (gap && String(tc.course_key || '').trim()) {
      err(TAB.TICKET_CATEGORIES, r, 'course_key', 'This category is a deliberate content gap, so it ' +
        'must have no course. Story 1 story 3 and all of scenario 2 depend on the gap existing.');
    }
    if (!gap && !String(tc.course_key || '').trim()) {
      warn(TAB.TICKET_CATEGORIES, r, 'course_key', 'No course, but not flagged as a deliberate gap. ' +
        'Tick is_deliberate_gap if that is intentional.');
    }
    if (!gap && tc.course_key && !courseByKey[tc.course_key]) {
      err(TAB.TICKET_CATEGORIES, r, 'course_key', 'Does not match any course: "' + tc.course_key + '".');
    }

    // "Don't let anyone add a Data Import course" — enforced rather than remembered.
    if (gap && label) {
      const clash = courseTitles.filter(t => t && (t.indexOf(label.toLowerCase()) !== -1 ||
        label.toLowerCase().indexOf(t) !== -1));
      if (clash.length) {
        err(TAB.COURSES, '', 'title', 'A course exists matching the deliberate gap "' + label +
          '" ("' + clash[0] + '"). That gap is load-bearing for the demo — remove the course or ' +
          'untick is_deliberate_gap deliberately.');
      }
    }
  });
}

function validateStats_(plan, accountByKey, err, warn) {
  plan.stats.byAccount.forEach(s => {
    const acct = accountByKey[s.account_key];
    if (!acct || !s.enrollments) return;

    if (s.target !== null && s.actual !== null && Math.abs(s.target - s.actual) > 2) {
      warn(TAB.ACCOUNTS, acct._row, 'required_complete_target', s.account_key +
        ' intends ' + s.target + '% but the data produces ' + s.actual + '% (' + s.completed +
        ' of ' + s.enrollments + ' enrollments). The demo will show ' + s.actual + '%.');
    }

    if (String(s.cohort).trim() === 'in_flight' && s.overdue === 0) {
      warn(TAB.ACCOUNTS, acct._row, 'cohort', s.account_key +
        ' is in-flight but has no overdue enrollments, so it cannot appear as "behind on required ' +
        'training". Move due_offset earlier.');
    }
    // "established" means different things per scenario: in uc1 it is "finished onboarding, should
    // be near 100%", in uc2 it is "live customer who still has training gaps, and the gap IS the
    // story". A scenario that declares the completion it wants is taken at its word — otherwise
    // this fires on every uc2 account and teaches everyone to ignore warnings.
    if (String(s.cohort).trim() === 'established' && s.actual !== null && s.actual < 100) {
      const declared = expectedCompletionFor_(s.use_case, s.account_key);
      if (declared === null) {
        warn(TAB.ACCOUNTS, acct._row, 'cohort', s.account_key + ' is established but only ' +
          s.actual + '% complete. If that is deliberate, declare it in scenario' +
          String(s.use_case).replace('uc', '') + 'Expected() and this warning will stop.');
      } else if (Math.abs(declared - s.actual) > 2) {
        warn(TAB.ACCOUNTS, acct._row, 'cohort', s.account_key + ' is at ' + s.actual +
          '% but scenario' + String(s.use_case).replace('uc', '') + 'Expected() declares ' +
          declared + '%. One of the two is out of date.');
      }
    }
    if (s.admins === 0) {
      warn(TAB.ACCOUNTS, acct._row, 'admin_count', s.account_key + ' has no admins, so any ' +
        'admins-only course at this account will enroll nobody.');
    }
  });
}


// ---------------------------------------------------------------------------
// Cross-scenario collisions
// ---------------------------------------------------------------------------

/**
 * Three people author three scenarios in one workbook, and all three seed into ONE LearnUpon portal
 * and ONE HubSpot portal. Some things are therefore global whether we like it or not: group titles,
 * course titles, email domains. Two scenarios claiming the same one is not a style problem, it
 * silently corrupts whichever demo runs second.
 *
 * These messages are written for someone who did not design the data model, because that is who
 * will hit them.
 */
function validateCrossScenario_(wb, err, warn) {
  // --- every use case in play should have an owner --------------------------
  const scenarios = {};
  (wb.scenarios || []).forEach(r => {
    if (r.use_case) scenarios[String(r.use_case).trim()] = r;
  });
  const used = {};
  wb.accounts.forEach(a => { if (a.use_case) used[String(a.use_case).trim()] = true; });
  Object.keys(used).forEach(uc => {
    if (!scenarios[uc]) {
      warn(TAB.SCENARIOS, '', 'use_case', 'Accounts exist for "' + uc + '" but the Scenarios tab ' +
        'has no row for it. Add one with an owner, so confirmation dialogs can tell people whose ' +
        'data they are about to change.');
    } else if (!String(scenarios[uc].owner_name || '').trim()) {
      warn(TAB.SCENARIOS, scenarios[uc]._row, 'owner_name', 'Scenario "' + uc + '" has no owner. ' +
        'Reset and Rebuild name the owner in their confirmation — without it that safeguard is blank.');
    }
  });

  // --- company names are LearnUpon group titles: globally unique ------------
  const byCompany = {};
  const byDomain = {};
  wb.accounts.forEach(a => {
    const company = String(a.company_name || '').trim().toLowerCase();
    const domain = String(a.domain || '').trim().toLowerCase();
    const uc = String(a.use_case || '').trim();

    if (company) {
      const prev = byCompany[company];
      if (prev && prev.uc !== uc) {
        err(TAB.ACCOUNTS, a._row, 'company_name',
          '"' + a.company_name + '" is also used by scenario ' + prev.uc + ' (row ' + prev.row +
          '). Company names must be unique across ALL scenarios, because each one becomes a ' +
          'LearnUpon group titled "Customer: <company>" in a single shared portal. Two groups with ' +
          'the same title make the demo unable to tell which account a learner belongs to, and the ' +
          'completion percentage for both scenarios becomes meaningless. Rename one of them. If ' +
          'they are genuinely meant to be the same company, the two scenarios must first agree on ' +
          'its headcount and completion percentage — they usually do not.');
      } else if (prev) {
        err(TAB.ACCOUNTS, a._row, 'company_name',
          'Duplicate company name within ' + uc + ' (also row ' + prev.row + ').');
      } else {
        byCompany[company] = { uc: uc, row: a._row };
      }
    }

    if (domain) {
      const prev = byDomain[domain];
      if (prev) {
        err(TAB.ACCOUNTS, a._row, 'domain',
          'Domain "' + domain + '" is already used by ' + (prev.uc === uc ? 'row ' + prev.row :
            'scenario ' + prev.uc + ' (row ' + prev.row + ')') + '. Learner emails are generated ' +
          'as first.last@domain, so two accounts on one domain will collide on email — and email ' +
          'is the join key between LearnUpon and HubSpot. Give each account its own domain.');
      } else {
        byDomain[domain] = { uc: uc, row: a._row };
      }
    }
  });

  // --- course titles are global too ----------------------------------------
  const byTitle = {};
  wb.courses.forEach(c => {
    const title = String(c.title || '').trim().toLowerCase();
    if (!title) return;
    const uc = String(c.use_case || '').trim();
    const prev = byTitle[title];
    if (prev && prev.uc !== uc) {
      err(TAB.COURSES, c._row, 'title',
        '"' + c.title + '" is also defined by scenario ' + prev.uc + ' (row ' + prev.row + '). ' +
        'There is one course catalogue in the portal, so a title can only exist once. If both ' +
        'scenarios genuinely need this course, delete one row and let them share it — courses are ' +
        'shared infrastructure and the group filter keeps each scenario\'s percentages separate. ' +
        'If they need different content, give them different titles.');
    } else {
      byTitle[title] = { uc: uc, row: c._row };
    }
  });

  // --- account keys are the identity used in every natural key -------------
  const byKey = {};
  wb.accounts.forEach(a => {
    const k = String(a.account_key || '').trim();
    if (!k) return;
    if (byKey[k]) {
      err(TAB.ACCOUNTS, a._row, 'account_key', 'Duplicate account_key "' + k + '" (also row ' +
        byKey[k] + '). Account keys appear in every manifest natural key, so a duplicate makes two ' +
        'different accounts indistinguishable to Reset and Verify.');
    }
    byKey[k] = a._row;
  });

  // --- is the scenario you are pointed at actually populated? --------------
  let scope = 'uc1';
  try { scope = activeUseCase(); } catch (e) { return; }
  if (scope !== 'all' && !used[scope]) {
    warn(TAB.SETTINGS, '', 'active_use_case', 'Settings.active_use_case is "' + scope +
      '" but no accounts exist for it. Every action is filtered to this scenario, so Preview and ' +
      'Seed will do nothing until it has accounts — or until you point it at a different scenario.');
  }
}


/** The completion a scenario file says it wants for an account, or null if it does not say. */
function expectedCompletionFor_(useCase, accountKey) {
  try {
    const exp = scenarioExpectedFor(useCase);
    const a = exp && exp.accounts && exp.accounts[accountKey];
    return a && typeof a.completion === 'number' ? a.completion : null;
  } catch (e) {
    return null;
  }
}
