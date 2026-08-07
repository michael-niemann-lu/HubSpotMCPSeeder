/**
 * Refresh.gs — keeping the seeded data current, without recreating it.
 *
 * Two paths, and you usually want the first:
 *
 *   refreshDueDates()  SAFE. Shifts due dates to today's anchor with PATCH. Nothing created or
 *                      deleted. Restores "due 18 days ago and still not started", which is what
 *                      Story 1's risk board actually reads. Enough on its own for in-flight accounts.
 *
 *   refreshRebuild()   DESTRUCTIVE. Deletes and recreates enrollments so COMPLETION dates move too.
 *                      Needed for the established cohort, whose completion dates are anchored to
 *                      their own onboarding start and therefore drift as T advances.
 *
 * The rebuild path only exists because spike 3 was wrong: a completed enrollment IS deletable, if
 * remove_from_history is the STRING "true".
 *
 * Two API facts this depends on, both measured:
 *   - PATCH /enrollments/{id} takes an UNWRAPPED body. The wrapped {Enrollment:{...}} form returns
 *     200 {"success":"ok"} and silently changes nothing.
 *   - Therefore every write is verified by reading it back. A 2xx proves nothing here.
 */

/** Reads current enrollment state per course — 4 calls rather than one per enrollment. */
function currentEnrollmentsByCourse_() {
  const courseIdByKey = {};
  manifestByType('course').forEach(row => {
    courseIdByKey[String(row.natural_key).replace(/^course:/, '')] = String(row.external_id);
  });
  const byId = {};
  Object.keys(courseIdByKey).forEach(courseKey => {
    const id = courseIdByKey[courseKey];
    try {
      firstArrayIn_(luGet_('enrollments/search?course_id=' + id).body, ['enrollments'])
        .filter(e => String(e.course_id) === id)
        .forEach(e => { byId[String(e.id)] = e; });
    } catch (e) { /* counted as unreadable by the caller */ }
  });
  return { byId: byId, courseIdByKey: courseIdByKey };
}

/** Which seeded enrollments hold a due date that no longer matches the plan. */
function dueDateWork_(plan, index, currentById) {
  const work = [];
  let unchanged = 0, notSeeded = 0, unreadable = 0;
  plan.learnupon.enrollments.forEach(e => {
    if (!e.due_date) return;
    const row = index[e.natural_key];
    if (!row) { notSeeded++; return; }
    const current = currentById[String(row.external_id)];
    if (!current) { unreadable++; return; }
    const want = ymd(e.due_date);
    const have = String(current.due_date || '').slice(0, 10);
    if (want === have) { unchanged++; return; }
    work.push({ id: String(row.external_id), want: want, have: have,
      email: e.email, course: e.course_title, natural_key: e.natural_key });
  });
  return { work: work, unchanged: unchanged, notSeeded: notSeeded, unreadable: unreadable };
}

/** Applies a due-date work list. Every PATCH is verified by reading it back. */
function applyDueDates_(work, notes) {
  let moved = 0, failed = 0;
  work.forEach(w => {
    try {
      // UNWRAPPED body. The wrapped {Enrollment:{...}} form returns 200 and changes nothing.
      luRequest_('patch', 'enrollments/' + w.id, { due_date: w.want }, { raw: true });
      const back = luGet_('enrollments/' + w.id, { allow404: true, raw: true });
      const rec = firstArrayIn_(back.body, ['enrollments', 'enrollment'])
        .filter(e => String(e.id) === w.id)[0];
      const now = rec ? String(rec.due_date || '').slice(0, 10) : '';
      if (now === w.want) moved++;
      else {
        failed++;
        notes.push(w.email + ' / ' + w.course + ': asked ' + w.want + ', portal still says ' +
          (now || 'unreadable'));
      }
    } catch (e) {
      failed++;
      notes.push(w.email + ': ' + String(e.message).slice(0, 140));
    }
  });
  return { moved: moved, failed: failed };
}

function refreshDueDates() {
  const gate = validateWorkbook({ silent: true });
  if (gate.errors > 0) {
    uiAlert('Refresh — blocked',
      gate.errors + ' validation error(s). Fix them first; see the _Validation tab.');
    return;
  }

  luResetCounters();
  const plan = scopedPlan();
  const index = manifestIndex();
  const T = resolveAnchor(getSettings());
  const currentById = currentEnrollmentsByCourse_().byId;

  const diff = dueDateWork_(plan, index, currentById);
  const work = diff.work;
  const unchanged = diff.unchanged, notSeeded = diff.notSeeded, unreadable = diff.unreadable;

  if (!work.length) {
    uiAlert('Refresh due dates',
      'Portal: ' + environmentLabel() + '\n\nNothing to shift — every due date already matches ' +
      'the plan at anchor ' + ymd(T) + '.\n\n' +
      unchanged + ' already correct\n' +
      (notSeeded ? notSeeded + ' not seeded yet\n' : '') +
      (unreadable ? unreadable + ' could not be read from the portal\n' : ''));
    return;
  }

  const shifts = work.map(w => daysBetween(coerceDate(w.have), coerceDate(w.want)));
  const minShift = Math.min.apply(null, shifts);
  const maxShift = Math.max.apply(null, shifts);

  const ui = SpreadsheetApp.getUi();
  const confirmed = ui.alert('Refresh due dates',
    'PORTAL:   ' + environmentLabel() + '\n' +
    'SCENARIO: ' + scopeLabel() + '\n\n' +
    'Anchor T is ' + ymd(T) + '.\n\n' +
    work.length + ' due date(s) will move' +
    (minShift === maxShift ? ' by ' + minShift + ' days.' :
      ', between ' + minShift + ' and ' + maxShift + ' days.') + '\n' +
    unchanged + ' already correct.\n\n' +
    'Nothing is created or deleted. Completion dates are left alone — use Refresh -> Rebuild\n' +
    'Enrollments if those need to move too.\n\n' +
    'First few:\n' + work.slice(0, 5).map(w =>
      '  ' + w.email + '\n    ' + w.have + '  ->  ' + w.want).join('\n'),
    ui.ButtonSet.OK_CANCEL);
  if (confirmed !== ui.Button.OK) return;

  const runId = newRunId();
  const notes = [];
  let moved = 0, failed = 0;

  withLock(function () {
    const r = applyDueDates_(work, notes);
    moved = r.moved;
    failed = r.failed;
  });

  // Recompute what the demo will now show, from the portal rather than from intent.
  const after = reconcilePlanToPortal_(plan);

  logAction({
    run_id: runId, action: 'refresh', phase: 'due-dates', platform: 'learnupon',
    object_type: 'enrollment', intended: work.length, succeeded: moved, failed: failed,
    notes: 'anchor ' + ymd(T)
  });

  uiAlert('Refresh — done',
    'Portal: ' + environmentLabel() + '\n\n' +
    'Due dates moved: ' + moved + '\n' +
    'Failed:          ' + failed + '\n' +
    'Already correct: ' + unchanged + '\n\n' +
    (notes.length ? 'Problems:\n' + notes.slice(0, 8).map(n => '  - ' + n).join('\n') + '\n\n' : '') +
    'Required-training percentage after refresh:\n' +
    after.byAccount.map(a => '  ' + (a.account_key + '              ').slice(0, 16) +
      a.portalPct + '%').join('\n') +
    '\n\nCompletion dates are unchanged by this path. If the established cohort has drifted, run ' +
    'Refresh -> Rebuild Enrollments.');
}

// ---------------------------------------------------------------------------
// Refresh -> Rebuild Enrollments (completion dates)
// ---------------------------------------------------------------------------

/**
 * The rebuild path: delete an enrollment and recreate it, so its COMPLETION DATE moves too.
 *
 * This exists because spike 3's conclusion was wrong. `DELETE /enrollments/{id}` does remove a
 * completed enrollment, provided remove_from_history is the STRING "true" — the boolean is rejected
 * with "failed to find the enrollment", which is what made the original spike conclude completions
 * were permanent. Verified on ACME 2026-08-06: delete, re-enroll, re-complete restored a completion
 * to its exact original date.
 *
 * Only enrollments whose resolved dates actually differ from the plan are rebuilt, so a second run
 * has nothing to do. Each rebuild is delete -> verify gone -> re-enroll -> re-complete, and the new
 * enrollment id replaces the old one in the manifest at the end, in one pass.
 *
 * Bounded by the client's call cap rather than by a row limit: it processes what it can, then tells
 * you how many remain. Re-run until it reports none.
 */
function refreshRebuild() {
  const gate = validateWorkbook({ silent: true });
  if (gate.errors > 0) {
    uiAlert('Rebuild — blocked', gate.errors + ' validation error(s). See the _Validation tab.');
    return;
  }

  luResetCounters();
  const plan = scopedPlan();
  const index = manifestIndex();
  const T = resolveAnchor(getSettings());

  // Current state per course: 4 calls rather than 223.
  const courseIdByKey = {};
  manifestByType('course').forEach(row => {
    courseIdByKey[String(row.natural_key).replace(/^course:/, '')] = String(row.external_id);
  });
  const currentById = {};
  Object.keys(courseIdByKey).forEach(k => {
    try {
      firstArrayIn_(luGet_('enrollments/search?course_id=' + courseIdByKey[k]).body, ['enrollments'])
        .filter(e => String(e.course_id) === String(courseIdByKey[k]))
        .forEach(e => { currentById[String(e.id)] = e; });
    } catch (e) { /* counted as unreadable below */ }
  });

  const work = [];
  let unchanged = 0, notSeeded = 0;
  plan.learnupon.enrollments.forEach(e => {
    const row = index[e.natural_key];
    if (!row) { notSeeded++; return; }
    const cur = currentById[String(row.external_id)];
    if (!cur) { notSeeded++; return; }

    const wantDone = e.date_completed ? ymd(e.date_completed) : '';
    const haveDone = String(cur.date_completed || '').slice(0, 10);
    const wantDue = e.due_date ? ymd(e.due_date) : '';
    const haveDue = String(cur.due_date || '').slice(0, 10);

    // A due-date-only difference is handled by the safe path; rebuild is for completion dates.
    if (wantDone === haveDone) { unchanged++; return; }
    work.push({ natural_key: e.natural_key, id: String(row.external_id), email: e.email,
      course_key: e.course_key, course_id: courseIdByKey[e.course_key],
      wantDone: wantDone, haveDone: haveDone, wantDue: wantDue, haveDue: haveDue,
      status: e.status });
  });

  if (!work.length) {
    uiAlert('Rebuild enrollments',
      'Portal: ' + environmentLabel() + '\n\nNothing to rebuild — every completion date already ' +
      'matches the plan at anchor ' + ymd(T) + '.\n\n' + unchanged + ' already correct' +
      (notSeeded ? '\n' + notSeeded + ' not seeded, or unreadable' : ''));
    return;
  }

  const ok = uiConfirmTyped('REBUILD ' + activeUseCase().toUpperCase(),
    'PORTAL:   ' + environmentLabel() + '\n' +
    'SCENARIO: ' + scopeLabel() + '\n\n' +
    'Anchor T is ' + ymd(T) + '.\n\n' +
    work.length + ' enrollment(s) will be DELETED AND RECREATED so their completion dates move.\n' +
    unchanged + ' already correct.\n\n' +
    'This is destructive: each enrollment is removed and a new one created in its place, with a\n' +
    'new id. Learning history for these enrollments is discarded — that is the point.\n\n' +
    'First few:\n' + work.slice(0, 5).map(w =>
      '  ' + w.email + '\n    ' + w.course_key + ': completed ' +
      (w.haveDone || 'never') + '  ->  ' + (w.wantDone || 'not completed')).join('\n'));
  if (!ok) return;

  const runId = newRunId();
  const idChanges = {};
  const completionChanges = {};
  let rebuilt = 0, failed = 0, remaining = 0;
  const notes = [];

  withLock(function () {
    for (let i = 0; i < work.length; i++) {
      const w = work[i];

      // Leave headroom for the manifest rewrite and a couple of retries.
      if (LU_CALLS_MADE > LU_MAX_CALLS_PER_RUN - 60) {
        remaining = work.length - i;
        break;
      }

      try {
        // 1. Remove it. The string "true" is load-bearing.
        luRequest_('delete', 'enrollments/' + w.id, { remove_from_history: 'true' }, { raw: true });
        const check = luGet_('enrollments/' + w.id, { allow404: true, raw: true });
        const still = check.code === 404 ? null
          : firstArrayIn_(check.body, ['enrollments', 'enrollment'])
              .filter(x => String(x.id) === w.id)[0];
        if (still) throw new Error('delete reported success but the enrollment is still there');

        // 2. Recreate it with the freshly resolved due date.
        const payload = { Enrollment: { email: w.email, course_id: Number(w.course_id) } };
        if (w.wantDue) payload.Enrollment.due_date = w.wantDue;
        const re = luPost_('enrollments', payload, { raw: true });
        const newId = idFrom_(re);
        if (!newId) throw new Error('re-enrol failed: HTTP ' + re.code + ' ' +
          String(re.raw || '').slice(0, 120));
        idChanges[w.natural_key] = newId;

        // 3. Re-complete it, if the plan says completed.
        if (w.status === 'completed' && w.wantDone) {
          const mc = luPost_('markcompletes', { Markcomplete: {
            enrollment_id: Number(newId), date_completed: w.wantDone + 'T12:00:00Z',
            status: 'completed'
          } }, { raw: true });
          const mcId = idFrom_(mc);
          if (!mcId) throw new Error('re-complete failed: HTTP ' + mc.code + ' ' +
            String(mc.raw || '').slice(0, 120));
          completionChanges['done:' + w.natural_key] = mcId;
        }
        rebuilt++;
      } catch (err) {
        failed++;
        notes.push(w.email + ' / ' + w.course_key + ': ' + String(err.message).slice(0, 150));
      }
    }

    // One rewrite for every id that changed, so a partial run still leaves a truthful ledger.
    manifestUpdateIds(idChanges);
    manifestUpdateIds(completionChanges);
  });

  logAction({
    run_id: runId, action: 'rebuild', phase: 'enrollments', platform: 'learnupon',
    object_type: 'enrollment', intended: work.length, succeeded: rebuilt, failed: failed,
    notes: 'anchor ' + ymd(T) + (remaining ? '; ' + remaining + ' remaining' : '')
  });

  const after = reconcilePlanToPortal_(plan);

  uiAlert('Rebuild — done',
    'Portal: ' + environmentLabel() + '\n\n' +
    'Rebuilt: ' + rebuilt + '\n' +
    'Failed:  ' + failed + '\n' +
    (remaining ? 'Remaining: ' + remaining + '  — stopped at the call cap. Run it again.\n' : '') +
    '\n' + (notes.length ? 'Problems:\n' + notes.slice(0, 8).map(n => '  - ' + n).join('\n') + '\n\n' : '') +
    'Required-training percentage after rebuild:\n' +
    after.byAccount.map(a => '  ' + (a.account_key + '              ').slice(0, 16) +
      a.demoPct + '%').join('\n') +
    '\n\nEnrollment ids changed, and _Manifest was updated to match. Run Verify.');
}

// ---------------------------------------------------------------------------
// Refresh — add & update
// ---------------------------------------------------------------------------

/**
 * Makes the portal match the scenario file: creates what is missing, updates what has drifted.
 *
 * This is the everyday action once a scenario is seeded. Edit ScenarioN.gs, Load, then Refresh —
 * new accounts and learners get created, changed due dates get patched, and anything it cannot fix
 * safely gets reported rather than silently ignored.
 *
 * What it will NOT do, deliberately:
 *   - move a completion date. That needs deleting and recreating the enrollment, which is
 *     destructive, so it stays behind Rebuild Enrollments.
 *   - delete records your scenario no longer describes. It counts them and points at Reset.
 *
 * Bounded by the client's call cap: it does what it can, then tells you how many records remain.
 * Re-run until it reports nothing left. That makes a 700-call first seed work here too, without a
 * six-minute execution limit ever being the problem.
 */
function refreshScenario() {
  const gate = validateWorkbook({ silent: true });
  if (gate.errors > 0) {
    uiAlert('Refresh — blocked',
      gate.errors + ' validation error(s). Fix them first; see the _Validation tab.');
    return;
  }

  luResetCounters();
  const scope = activeUseCase();
  const plan = scopedPlan();
  const index = manifestIndex();
  const T = resolveAnchor(getSettings());

  // --- what is missing ------------------------------------------------------
  const missing = { groups: 0, users: 0, memberships: 0, courses: 0, enrollments: 0, completions: 0 };
  plan.learnupon.groups.forEach(g => { if (!index[g.natural_key]) missing.groups++; });
  plan.learnupon.users.forEach(u => { if (!index[u.natural_key]) missing.users++; });
  plan.learnupon.memberships.forEach(m => { if (!index[m.natural_key]) missing.memberships++; });
  plan.learnupon.courses.forEach(c => { if (!index[c.natural_key]) missing.courses++; });
  plan.learnupon.enrollments.forEach(e => {
    if (!index[e.natural_key]) missing.enrollments++;
    if (e.status === 'completed' && !index['done:' + e.natural_key]) missing.completions++;
  });
  const totalMissing = Object.keys(missing).reduce((s, k) => s + missing[k], 0);

  // --- what has drifted, and what no longer belongs -------------------------
  let dueDrift = { work: [], unchanged: 0, notSeeded: 0, unreadable: 0 };
  let completionDrift = 0;
  const current = currentEnrollmentsByCourse_();
  dueDrift = dueDateWork_(plan, index, current.byId);

  plan.learnupon.enrollments.forEach(e => {
    const row = index[e.natural_key];
    if (!row) return;
    const cur = current.byId[String(row.external_id)];
    if (!cur) return;
    const want = e.date_completed ? ymd(e.date_completed) : '';
    const have = String(cur.date_completed || '').slice(0, 10);
    if (want !== have) completionDrift++;
  });

  const planned = {};
  plan.learnupon.enrollments.forEach(e => { planned[e.natural_key] = true; });
  const orphans = manifestByType('enrollment')
    .filter(r => inScope_(r.use_case, scope) && !planned[r.natural_key]).length;

  if (!totalMissing && !dueDrift.work.length && !completionDrift && !orphans) {
    uiAlert('Refresh — nothing to do',
      'Portal:   ' + environmentLabel() + '\n' +
      'Scenario: ' + scopeLabel() + '\n\n' +
      'The portal already matches your scenario file at anchor ' + ymd(T) + '.\n\n' +
      plan.learnupon.enrollments.length + ' enrollment(s) checked.');
    return;
  }

  // --- confirm --------------------------------------------------------------
  const lines = [];
  if (totalMissing) {
    lines.push('CREATE ' + totalMissing + ' missing record(s):');
    Object.keys(missing).forEach(k => { if (missing[k]) lines.push('   ' + missing[k] + ' ' + k); });
  }
  if (dueDrift.work.length) lines.push('UPDATE ' + dueDrift.work.length + ' due date(s)');
  if (completionDrift) {
    lines.push('LEAVE ALONE: ' + completionDrift + ' completion date(s) differ from the plan.');
    lines.push('   Moving those means deleting and recreating the enrollment —');
    lines.push('   use Rebuild Enrollments if you want them changed.');
  }
  if (orphans) {
    lines.push('LEAVE ALONE: ' + orphans + ' enrollment(s) your scenario no longer describes.');
    lines.push('   Use Reset if you want them removed.');
  }

  const ui = SpreadsheetApp.getUi();
  const proceed = ui.alert('Refresh — add & update',
    'PORTAL:   ' + environmentLabel() + '\n' +
    'SCENARIO: ' + scopeLabel() + '\n' +
    'Anchor T is ' + ymd(T) + '.\n\n' + lines.join('\n') +
    '\n\nNothing is deleted by this action.', ui.ButtonSet.OK_CANCEL);
  if (proceed !== ui.Button.OK) return;

  // --- execute --------------------------------------------------------------
  const runId = newRunId();
  const notes = [];
  let created = 0, failed = 0, movedDates = 0, remaining = 0;

  withLock(function () {
    // Phases in dependency order. Each rebuilds its own view of the manifest, because the phase
    // before it has just added rows that this one needs to resolve.
    const phases = [phaseUsersGroups_, phaseCourses_, phaseEnrollments_, phaseCompletions_];
    for (let i = 0; i < phases.length; i++) {
      if (LU_CALLS_MADE > LU_MAX_CALLS_PER_RUN - 120) {
        remaining = 1;   // at least one phase untouched; the exact count is re-derived on re-run
        break;
      }
      const work = phases[i].build(plan, manifestIndex());
      if (work.blocked && work.blocked.length) {
        notes.push(phases[i].phase + ': ' + work.blocked.length +
          ' blocked because a prerequisite is missing — re-run Refresh');
        continue;
      }
      if (!work.items.length) continue;
      const result = phases[i].execute(work, runId, plan);
      created += result.succeeded;
      failed += result.failed;
      result.notes.forEach(n => notes.push(n));
    }

    // Due dates last: the enrollments created moments ago already carry the planned date, so this
    // only touches ones that existed before.
    if (!remaining && dueDrift.work.length && LU_CALLS_MADE < LU_MAX_CALLS_PER_RUN - 60) {
      const fresh = dueDateWork_(plan, manifestIndex(), currentEnrollmentsByCourse_().byId);
      const r = applyDueDates_(fresh.work, notes);
      movedDates = r.moved;
      failed += r.failed;
    } else if (dueDrift.work.length) {
      remaining = 1;
    }
  });

  logAction({
    run_id: runId, action: 'refresh-sync', phase: 'add-update', platform: 'learnupon',
    object_type: 'scenario', intended: totalMissing + dueDrift.work.length,
    succeeded: created + movedDates, failed: failed,
    notes: 'anchor ' + ymd(T) + (remaining ? '; more remaining' : '')
  });

  uiAlert('Refresh — done',
    'Portal:   ' + environmentLabel() + '\n' +
    'Scenario: ' + scopeLabel() + '\n\n' +
    'Created:          ' + created + '\n' +
    'Due dates moved:  ' + movedDates + '\n' +
    'Failed:           ' + failed + '\n' +
    (remaining ? '\nStopped at the call cap with work left. Run Refresh again.\n' : '') +
    (completionDrift ? '\n' + completionDrift + ' completion date(s) still differ — Rebuild Enrollments.\n' : '') +
    (orphans ? orphans + ' enrollment(s) no longer in your scenario — Reset to remove.\n' : '') +
    (notes.length ? '\nProblems:\n' + notes.slice(0, 8).map(n => '  - ' + n).join('\n') + '\n' : '') +
    '\nRun Verify to confirm the portal matches the plan.');
}
