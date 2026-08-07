/**
 * Reset.gs and Verify.gs behaviour — cleanup, and proof that cleanup did no harm.
 *
 * Reset touches enrollments and nothing else. Users, groups, memberships and courses are created
 * once and are never removed by this toolkit.
 *
 * Spike 3 changed what reset can honestly promise. A Completed enrollment cannot be deleted:
 * DELETE returns HTTP 200 and silently does nothing, and deleting the course does not take the
 * completion with it either. So reset removes what it can, verifies each removal by reading it
 * back, and reports the rest as permanent. It must never claim to have removed a completion.
 */

function resetEnrollments() {
  withLock(function () {
    luResetCounters();

    const scope = activeUseCase();
    const rows = manifestByType('enrollment').filter(r => inScope_(r.use_case, scope));
    if (!rows.length) {
      uiAlert('Reset enrollments', 'The manifest lists no enrollments. Nothing to do.\n\n' +
        'Reset only ever deletes what the manifest records — it never searches the portal.');
      return;
    }

    const completions = {};
    manifestByType('completion').forEach(c => {
      completions[String(c.parent_external_id)] = true;
    });
    const likelyPermanent = rows.filter(r => completions[String(r.external_id)]).length;

    // The typed word names the scenario, so resetting the wrong one takes deliberate effort.
    const ok = uiConfirmTyped('RESET ' + scope.toUpperCase(),
      'PORTAL:   ' + environmentLabel() + '\n' +
      'SCENARIO: ' + scopeLabel() + '\n\n' +
      'The manifest lists ' + rows.length + ' enrollment(s) for this scenario.\n' +
      (likelyPermanent
        ? '\n' + likelyPermanent + ' of them are completed. Those ARE deletable, via\n' +
          'remove_from_history — a completion is not permanent after all.\n'
        : '') +
      '\nUsers, groups, memberships and courses are NOT touched.\n' +
      'Other scenarios are NOT touched — this acts only on ' + scope + '.');
    if (!ok) return;

    const runId = newRunId();
    const deleted = [];
    const permanent = [];
    const failures = [];

    rows.forEach(row => {
      const id = String(row.external_id);
      try {
        // Layer 2 — look before you delete. A stale manifest or a recycled id must not become a
        // delete against somebody else's record.
        const before = luGet_('enrollments/' + id, { allow404: true, raw: true });
        if (before.code === 404 || !before.body) {
          deleted.push(row.natural_key);   // already gone; treat as success so reset is resumable
          return;
        }
        const rec = firstArrayIn_(before.body, ['enrollments', 'enrollment'])
          .filter(e => String(e.id) === id)[0];
        if (!rec) {
          failures.push(id + ': could not read it back before deleting — skipped');
          return;
        }
        if (String(rec.email || '').toLowerCase() !== String(row.extra || '').toLowerCase()) {
          failures.push(id + ': manifest says ' + row.extra + ' but the portal says ' +
            rec.email + ' — SKIPPED, this is not our record');
          return;
        }

        // remove_from_history must be the STRING "true". The boolean is rejected with
        // "failed to find the enrollment", which is what made spike 3 conclude, wrongly, that
        // completed enrollments could never be deleted.
        luRequest_('delete', 'enrollments/' + id, { remove_from_history: 'true' }, { raw: true });

        // A 200 proves nothing on this API. Read it back.
        const after = luGet_('enrollments/' + id, { allow404: true, raw: true });
        const still = after.code === 404 ? null
          : firstArrayIn_(after.body, ['enrollments', 'enrollment'])
              .filter(e => String(e.id) === id)[0];

        if (!still) deleted.push(row.natural_key);
        else permanent.push(row.natural_key + ' (' + (still.status || 'completed') + ')');
      } catch (e) {
        failures.push(id + ': ' + String(e.message).slice(0, 140));
      }
    });

    // Manifest rows come out only for confirmed deletions, so a partial run leaves a true ledger.
    // The completion row rides along: deleting the enrollment removes the completion in the portal,
    // and leaving a "done:" row behind would make the next Seed Completions skip work that no
    // longer exists.
    manifestRemove(deleted.concat(deleted.map(k => 'done:' + k)));

    logAction({
      run_id: runId, action: 'reset', phase: 'enrollments', platform: 'learnupon',
      object_type: 'enrollment', intended: rows.length, succeeded: deleted.length,
      failed: failures.length,
      notes: permanent.length + ' permanent (completed, undeletable)'
    });

    uiAlert('Reset enrollments — done',
      'Portal: ' + environmentLabel() + '\n\n' +
      'Deleted:    ' + deleted.length + '\n' +
      'Permanent:  ' + permanent.length + '  (completed — the API cannot remove these)\n' +
      'Skipped:    ' + failures.length + '\n\n' +
      (permanent.length
        ? 'Left in place, and left in the manifest because they still exist:\n' +
          permanent.slice(0, 8).map(p => '  - ' + p).join('\n') +
          (permanent.length > 8 ? '\n  ... and ' + (permanent.length - 8) + ' more' : '') + '\n\n'
        : '') +
      (failures.length ? 'Skipped:\n' + failures.slice(0, 8).map(f => '  - ' + f).join('\n') + '\n\n' : '') +
      'Now run Verify to confirm the persistent roster is intact.');
  });
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Confirms that everything the manifest says is persistent still exists, AND that the portal
 * matches the plan.
 *
 * The second half exists because the first half once reported "Everything the manifest records is
 * still present" on a dataset that was missing 185 completions. Manifest-to-portal agreement is
 * necessary and nowhere near sufficient: the question a demo depends on is whether the PORTAL
 * matches the PLAN.
 */
function verifySeed() {
  luResetCounters();
  const scope = activeUseCase();
  const plan = scopedPlan();
  const counts = manifestCounts();
  const lines = ['Portal:   ' + environmentLabel(), 'Scenario: ' + scopeLabel(), '',
    'Manifest contents (all scenarios):'];
  Object.keys(counts).sort().forEach(k => {
    lines.push('  ' + (k + '                ').slice(0, 14) + counts[k]);
  });

  // --- persistent roster ---------------------------------------------------
  let missing = 0;
  const problems = [];
  lines.push('', 'Persistent roster (manifest -> portal):');

  const checkAll = function (objectType, label, exists) {
    const rows = manifestByType(objectType)
      .filter(r => objectType === 'course' || inScope_(r.use_case, scope));
    if (!rows.length) return;
    let present = 0;
    rows.forEach(row => {
      try {
        if (exists(String(row.external_id))) present++;
        else {
          missing++;
          problems.push(label + ' ' + row.natural_key + ' (id ' + row.external_id + ') is GONE');
        }
      } catch (e) {
        problems.push(label + ' ' + row.natural_key + ': lookup failed — ' + String(e.message).slice(0, 80));
      }
    });
    lines.push('  ' + (label + '                ').slice(0, 14) + present + ' of ' + rows.length + ' present');
  };

  checkAll('user', 'users', function (id) {
    const body = luGet_('users/' + id, { allow404: true, raw: true }).body;
    return !!firstArrayIn_(body, ['user', 'users']).filter(u => String(u.id) === id)[0];
  });
  checkAll('course', 'courses', function (id) {
    const body = luGet_('courses?course_id=' + id, { raw: true }).body;
    return !!firstArrayIn_(body, ['courses']).filter(c => String(c.id) === id)[0];
  });

  // --- plan vs portal ------------------------------------------------------
  const recon = reconcilePlanToPortal_(plan);
  lines.push('', 'Enrollment reconciliation (plan -> portal):');
  lines.push('  course                             plan  portal   complete plan/portal');
  recon.byCourse.forEach(c => {
    lines.push('  ' + (c.title + '                                   ').slice(0, 35) +
      String(c.planTotal).padEnd(6) + String(c.portalTotal).padEnd(9) +
      c.planCompleted + ' / ' + c.portalCompleted +
      (c.planTotal !== c.portalTotal || c.planCompleted !== c.portalCompleted ? '   <-- MISMATCH' : ''));
  });

  lines.push('', 'Required-training percentage:');
  lines.push('  account          intended  our courses  AS THE DEMO SEES IT');
  recon.byAccount.forEach(a => {
    lines.push('  ' + (a.account_key + '              ').slice(0, 17) +
      String(a.planPct + '%').padEnd(10) + String(a.portalPct + '%').padEnd(13) +
      String(a.demoPct + '%').padEnd(6) +
      (a.strayTotal ? '  <-- DILUTED by ' + a.strayTotal + ' stray enrollment(s)' :
        (Math.abs(a.planPct - a.portalPct) > 2 ? '  <-- WRONG' : '')));
  });

  // What the scenario file says it is aiming for. Informative only — nothing is blocked by it.
  const expected = scenarioExpectedFor(scope);
  if (expected && expected.accounts) {
    const rows = recon.byAccount.filter(a => expected.accounts[a.account_key]);
    if (rows.length) {
      lines.push('', 'Against the numbers ' + scope + ' says it is aiming for:');
      rows.forEach(a => {
        const want = expected.accounts[a.account_key];
        const drift = Math.abs((want.completion || 0) - a.demoPct);
        lines.push('  ' + (a.account_key + '              ').slice(0, 17) +
          'wants ' + String(want.completion + '%').padEnd(7) + 'has ' + String(a.demoPct + '%').padEnd(7) +
          (drift > 2 ? '  <-- off by ' + drift + ' points' : 'ok') +
          (want.note ? '   ' + want.note : ''));
      });
    }
    (expected.notes || []).forEach(n => lines.push('  note: ' + n));
  }

  if (recon.strays.length) {
    const byCourse = {};
    recon.strays.forEach(s2 => {
      byCourse[s2.course] = (byCourse[s2.course] || 0) + 1;
    });
    lines.push('', '*** ' + recon.strays.length + ' STRAY ENROLLMENT(S) ***');
    lines.push('Our users are enrolled in courses this toolkit did not create. The demo computes');
    lines.push('"required training" from everything a group is enrolled in, so these dilute every');
    lines.push('percentage above. Most likely the portal auto-enrols new users somewhere.');
    Object.keys(byCourse).forEach(c => lines.push('  ' + byCourse[c] + ' x  ' + c));
    lines.push('Fix: turn off that auto-enrolment in the portal, then run');
    lines.push('     Developer -> Remove Stray Enrollments.');
  }

  if (recon.orphans.length) {
    lines.push('', recon.orphans.length + ' enrollment(s) exist in the portal but are NOT in the ' +
      'manifest. Reset cannot clean those up. Run Developer -> Repair Manifest.');
  }

  // The completion ledger is separate from enrollment status, and drifts separately. Reset uses it
  // to warn which enrollments are permanent, so an undercount makes that warning lie.
  const ledgerCompletions = manifestByType('completion').length;
  if (ledgerCompletions !== recon.portalCompleted) {
    lines.push('', 'Completion ledger drift: _Manifest records ' + ledgerCompletions +
      ' completion(s) but the portal holds ' + recon.portalCompleted + '.');
    lines.push('  The portal is correct — the demo is fine. Re-run Seed -> 4. Completions to ' +
      'close the gap; it now adopts completions that already exist.');
  }

  lines.push('');
  if (missing > 0) {
    lines.push('*** ' + missing + ' PERSISTENT RECORD(S) MISSING ***');
    lines.push('This is a bug, not a cleanup. Users and courses must survive every reset.');
  }
  if (recon.broken) {
    lines.push('*** THE PORTAL DOES NOT MATCH THE PLAN ***');
    lines.push('Re-run the phase that is short. Every phase is idempotent, so re-running is safe.');
  }
  if (!missing && !recon.broken && !recon.orphans.length && !recon.strays.length) {
    lines.push('Portal matches the plan, the persistent roster is intact, and our users are ' +
      'enrolled in nothing but their required courses.');
  }
  if (problems.length) {
    lines.push('', problems.slice(0, 10).map(p => '  - ' + p).join('\n'));
  }

  logAction({
    run_id: newRunId(), action: 'verify', phase: 'verify', platform: 'learnupon',
    object_type: 'all', intended: plan.learnupon.enrollments.length,
    succeeded: recon.portalTotal, failed: missing + (recon.broken ? 1 : 0),
    notes: recon.broken ? 'PORTAL DOES NOT MATCH PLAN' : 'reconciled'
  });

  uiAlert('Verify', lines.join('\n'));
}

/** Counts what the portal actually holds, per course and per account, and compares with the plan. */
function reconcilePlanToPortal_(plan) {
  const accountByEmail = {};
  plan.learnupon.users.forEach(u => { accountByEmail[String(u.email).toLowerCase()] = u.account_key; });

  const courseIdByKey = {};
  const ourCourseIds = {};
  manifestByType('course').forEach(row => {
    courseIdByKey[String(row.natural_key).replace(/^course:/, '')] = String(row.external_id);
    ourCourseIds[String(row.external_id)] = true;
  });

  const manifestEnrollmentIds = {};
  manifestByType('enrollment').forEach(r => { manifestEnrollmentIds[String(r.external_id)] = true; });

  const byCourse = [];
  const acct = {};
  const orphans = [];
  const strays = [];
  let portalTotal = 0, portalCompleted = 0, broken = false;

  const planByCourse = {};
  plan.learnupon.enrollments.forEach(e => {
    const b = planByCourse[e.course_key] = planByCourse[e.course_key] ||
      { title: e.course_title, total: 0, completed: 0 };
    b.total++;
    if (e.status === 'completed') b.completed++;
    const a = acct[e.account_key] = acct[e.account_key] ||
      { account_key: e.account_key, planTotal: 0, planCompleted: 0, portalTotal: 0, portalCompleted: 0 };
    a.planTotal++;
    if (e.status === 'completed') a.planCompleted++;
  });

  Object.keys(planByCourse).forEach(courseKey => {
    const expected = planByCourse[courseKey];
    const courseId = courseIdByKey[courseKey];
    let rows = [];
    if (courseId) {
      try {
        rows = firstArrayIn_(luGet_('enrollments/search?course_id=' + courseId).body, ['enrollments'])
          .filter(e => String(e.course_id) === courseId);   // never trust a filtered read
      } catch (e) { /* counted as zero below */ }
    }
    const completed = rows.filter(e => String(e.status) === 'completed').length;
    portalTotal += rows.length;
    portalCompleted += completed;

    rows.forEach(e => {
      const a = acct[accountByEmail[String(e.email || '').toLowerCase()]];
      if (a) {
        a.portalTotal++;
        if (String(e.status) === 'completed') a.portalCompleted++;
      }
      if (!manifestEnrollmentIds[String(e.id)]) orphans.push(String(e.id));
    });

    if (rows.length !== expected.total || completed !== expected.completed) broken = true;
    byCourse.push({ title: expected.title, planTotal: expected.total, portalTotal: rows.length,
      planCompleted: expected.completed, portalCompleted: completed });
  });

  // Enrollments our users hold in courses we did NOT create. The demo reads "required training" as
  // everything a group is enrolled in, so a single stray course silently dilutes every percentage.
  // ACME auto-enrols new users in a welcome course, which is exactly how this was found.
  manifestByType('user').forEach(row => {
    const email = String(row.extra || '').toLowerCase();
    const account = accountByEmail[email];
    if (!account) return;   // another scenario's user; not ours to reconcile here
    try {
      firstArrayIn_(luGet_('enrollments/search?user_id=' + row.external_id).body, ['enrollments'])
        .forEach(e => {
          if (ourCourseIds[String(e.course_id)]) return;
          strays.push({ id: String(e.id), email: email, course_id: String(e.course_id),
            course: String(e.course_name || e.name || '(unnamed)'), status: String(e.status || ''),
            account_key: account || '' });
          const a = acct[account];
          if (a) {
            a.strayTotal = (a.strayTotal || 0) + 1;
            if (String(e.status) === 'completed') a.strayCompleted = (a.strayCompleted || 0) + 1;
          }
        });
    } catch (err) { /* a single unreadable user must not abort the whole check */ }
  });

  const byAccount = Object.keys(acct).map(k => {
    const a = acct[k];
    a.strayTotal = a.strayTotal || 0;
    a.strayCompleted = a.strayCompleted || 0;
    a.planPct = a.planTotal ? Math.round(100 * a.planCompleted / a.planTotal) : 0;
    a.portalPct = a.portalTotal ? Math.round(100 * a.portalCompleted / a.portalTotal) : 0;
    // What the demo will actually say, because it counts everything the group is enrolled in.
    const demoTotal = a.portalTotal + a.strayTotal;
    const demoDone = a.portalCompleted + a.strayCompleted;
    a.demoPct = demoTotal ? Math.round(100 * demoDone / demoTotal) : 0;
    return a;
  });

  return { byCourse: byCourse, byAccount: byAccount, orphans: orphans, strays: strays,
    portalTotal: portalTotal, portalCompleted: portalCompleted, broken: broken };
}

/**
 * Adopts enrollments that exist in the portal but are missing from the manifest.
 *
 * This is the one place we look records up rather than reading the manifest, and it is safe because
 * it only ever ADDS a ledger row — never deletes — and only for a record whose user and course are
 * both already ours. Without it, an enrollment lost to a manifest race can never be completed or
 * reset: it is invisible to every other code path.
 */
function repairManifest() {
  luResetCounters();
  const plan = expand(loadWorkbook());
  const index = manifestIndex();

  const courseIdByKey = {};
  manifestByType('course').forEach(row => {
    courseIdByKey[String(row.natural_key).replace(/^course:/, '')] = String(row.external_id);
  });
  const ourUserEmails = {};
  manifestByType('user').forEach(row => { ourUserEmails[String(row.extra).toLowerCase()] = true; });

  // plan enrollment identity, keyed by the pair the portal can tell us about
  const planByPair = {};
  plan.learnupon.enrollments.forEach(e => {
    planByPair[String(e.email).toLowerCase() + '|' + e.course_key] = e;
  });

  const adopted = [];
  const unknown = [];
  const corrected = [];
  const stale = {};

  Object.keys(courseIdByKey).forEach(courseKey => {
    const courseId = courseIdByKey[courseKey];
    let rows = [];
    try {
      rows = firstArrayIn_(luGet_('enrollments/search?course_id=' + courseId).body, ['enrollments'])
        .filter(e => String(e.course_id) === courseId);
    } catch (e) { return; }

    rows.forEach(e => {
      const email = String(e.email || '').toLowerCase();
      if (!ourUserEmails[email]) { unknown.push(String(e.id) + ' (' + email + ')'); return; }
      const planned = planByPair[email + '|' + courseKey];
      if (!planned) { unknown.push(String(e.id) + ' (' + email + ' / ' + courseKey + ')'); return; }
      const existing = index[planned.natural_key];
      if (existing) {
        // A rebuild changes the enrollment id. A manifest row pointing at the old one is worse than
        // no row: reset would 404 on it and quietly drop the ledger entry.
        if (String(existing.external_id) !== String(e.id)) {
          stale[planned.natural_key] = String(e.id);
          corrected.push(email + ' / ' + courseKey + ': ' + existing.external_id + ' -> ' + e.id);
        }
        return;
      }

      manifestAppend('repair', [{ object_type: 'enrollment', class: 'disposable',
        external_id: String(e.id), natural_key: planned.natural_key,
        use_case: planned.use_case, parent_external_id: courseId, extra: email }]);
      index[planned.natural_key] = { external_id: String(e.id) };
      adopted.push(email + ' / ' + courseKey);
    });
  });

  const fixed = manifestUpdateIds(stale);

  uiAlert('Repair Manifest',
    'Portal: ' + environmentLabel() + '\n\n' +
    'Adopted into the manifest: ' + adopted.length + '\n' +
    'Stale ids corrected: ' + fixed + '\n' +
    'Left alone (not ours, or not in the plan): ' + unknown.length + '\n\n' +
    (corrected.length ? corrected.slice(0, 6).map(c => '  ~ ' + c).join('\n') + '\n\n' : '') +
    (adopted.length ? adopted.slice(0, 10).map(a => '  + ' + a).join('\n') +
      (adopted.length > 10 ? '\n  ... and ' + (adopted.length - 10) + ' more' : '') + '\n\n' : '') +
    'Only ledger rows were added. Nothing was created, changed or deleted in the portal.\n' +
    'Run Verify next, then re-run any phase that is short.');
}


// ---------------------------------------------------------------------------
// Developer -> Remove Stray Enrollments
// ---------------------------------------------------------------------------

/**
 * Removes enrollments our users hold in courses this toolkit did not create.
 *
 * THIS IS A DELIBERATE, NARROW EXCEPTION TO LAYER 1. Everywhere else, the manifest is the only
 * authority for deletion. Here the authority is different and deliberately stated:
 *
 *     the enrollment belongs to a user WE created (it is in the manifest as a user),
 *     and the course is NOT one of ours.
 *
 * That is sound because we created the user, and the enrollment only exists as a side effect of
 * that creation — ACME auto-enrols new users in a welcome course. It is still an exception, so it
 * lives behind its own menu item, refuses to touch anything completed, verifies each delete by
 * reading it back, and never runs as part of Reset.
 *
 * Turn the portal's auto-enrolment off first, or the next seed recreates them all.
 */
function removeStrayEnrollments() {
  luResetCounters();

  const ourCourseIds = {};
  manifestByType('course').forEach(r => { ourCourseIds[String(r.external_id)] = true; });
  const scope = activeUseCase();
  const users = manifestByType('user').filter(r => inScope_(r.use_case, scope));
  if (!users.length) {
    uiAlert('Remove stray enrollments', 'No users in the manifest for this environment.');
    return;
  }

  const strays = [];
  const unreadable = [];
  users.forEach(row => {
    try {
      firstArrayIn_(luGet_('enrollments/search?user_id=' + row.external_id).body, ['enrollments'])
        .forEach(e => {
          if (ourCourseIds[String(e.course_id)]) return;
          strays.push({ id: String(e.id), email: String(row.extra || '').toLowerCase(),
            course: String(e.course_name || e.name || '(unnamed)'),
            status: String(e.status || '') });
        });
    } catch (err) {
      unreadable.push(String(row.extra));
    }
  });

  if (!strays.length) {
    uiAlert('Remove stray enrollments',
      'Portal: ' + environmentLabel() + '\n\nNone found. Our ' + users.length + ' users are ' +
      'enrolled in nothing but their required courses.' +
      (unreadable.length ? '\n\n' + unreadable.length + ' user(s) could not be read.' : ''));
    return;
  }

  const byCourse = {};
  strays.forEach(x => { byCourse[x.course] = (byCourse[x.course] || 0) + 1; });
  const completed = strays.filter(x => x.status === 'completed');

  const ok = uiConfirmTyped('REMOVE STRAYS',
    'PORTAL: ' + environmentLabel() + '\n\n' +
    strays.length + ' enrollment(s) on OUR users, in courses we did not create:\n' +
    Object.keys(byCourse).map(c => '  ' + byCourse[c] + ' x  ' + c).join('\n') + '\n\n' +
    'These dilute every required-training percentage in the demo.\n\n' +
    (completed.length
      ? completed.length + ' of them are COMPLETED and cannot be deleted — they will be skipped.\n\n'
      : '') +
    'Note: this is the one action that deletes records the manifest does not list. Its authority is\n' +
    'that each enrollment belongs to a user we created. Nothing else is touched.\n\n' +
    'Turn off the portal auto-enrolment first, or the next seed will recreate them.');
  if (!ok) return;

  const runId = newRunId();
  let deleted = 0, skipped = 0;
  const notes = [];

  withLock(function () {
    strays.forEach(x => {
      if (x.status === 'completed') {
        skipped++;
        notes.push(x.email + ' / ' + x.course + ': completed, cannot be deleted');
        return;
      }
      try {
        luRequest_('delete', 'enrollments/' + x.id, { remove_from_history: 'true' }, { raw: true });
        const back = luGet_('enrollments/' + x.id, { allow404: true, raw: true });
        const still = back.code === 404 ? null
          : firstArrayIn_(back.body, ['enrollments', 'enrollment'])
              .filter(e => String(e.id) === x.id)[0];
        if (still) {
          skipped++;
          notes.push(x.email + ' / ' + x.course + ': delete returned success but it is still there');
        } else {
          deleted++;
        }
      } catch (e) {
        skipped++;
        notes.push(x.email + ': ' + String(e.message).slice(0, 120));
      }
    });
  });

  logAction({
    run_id: runId, action: 'remove-strays', phase: 'cleanup', platform: 'learnupon',
    object_type: 'enrollment', intended: strays.length, succeeded: deleted, failed: skipped,
    notes: 'enrollments outside the required course set'
  });

  uiAlert('Remove stray enrollments — done',
    'Portal: ' + environmentLabel() + '\n\n' +
    'Deleted: ' + deleted + '\n' +
    'Skipped: ' + skipped + '\n\n' +
    (notes.length ? notes.slice(0, 8).map(n => '  - ' + n).join('\n') + '\n\n' : '') +
    'Run Verify — the percentages should now match the plan.');
}
