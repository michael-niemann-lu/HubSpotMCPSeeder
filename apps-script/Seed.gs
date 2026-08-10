/**
 * Seed.gs — the write paths, one bounded phase per menu action.
 *
 * Every phase: check the lock -> validate (hard gate) -> expand -> build a work list by diffing the
 * plan against the manifest -> confirm with counts and the target portal -> execute -> log.
 *
 * Phases are separate because of the 6-minute execution limit, and because seeding is idempotent
 * against the manifest a timeout just means running that phase again. Nothing here needs
 * continuation triggers.
 *
 * Two habits this API forced on us, both non-negotiable:
 *   - POST bodies are wrapped in a capitalised resource object; PATCH bodies are not
 *   - a 2xx is not proof a write happened, so we read ids back out of responses and verify
 */

function seedUsersAndGroups() { runPhase_('Seed: users, groups, memberships', phaseUsersGroups_); }
function seedCourses() { runPhase_('Seed: courses', phaseCourses_); }
function seedEnrollments() { runPhase_('Seed: enrollments', phaseEnrollments_); }
function seedCompletions() { runPhase_('Seed: completions', phaseCompletions_); }

// ---------------------------------------------------------------------------
// Phase runner
// ---------------------------------------------------------------------------

function runPhase_(title, fn) {
  const gate = validateWorkbook({ silent: true });
  if (gate.errors > 0) {
    uiAlert(title + ' — blocked',
      gate.errors + ' validation error(s). Seeding refuses to run until they are fixed.\n\n' +
      'See the _Validation tab.');
    return;
  }

  luResetCounters();
  const plan = scopedPlan();
  const work = fn.build(plan, manifestIndex());

  if (work.blockedCourses && work.blockedCourses.length) {
    uiAlert(title + ' — blocked',
      'Nothing was created. These courses cannot be given content:\n\n' +
      work.blockedCourses.map(b => '  - ' + b).join('\n') +
      '\n\nModule ids are specific to a portal. Use Setup -> Find a Module against a course in ' +
      environmentLabel() + ', then either put the id in the Courses tab (source_module_id) or set ' +
      'Settings.default_source_module_id so every scenario falls back to it.');
    return;
  }

  // A phase whose prerequisites are missing must refuse, not quietly do less than asked.
  if (work.blocked && work.blocked.length) {
    uiAlert(title + ' — blocked',
      work.blocked.length + ' record(s) cannot be created because the enrollment they depend on is ' +
      'not in _Manifest.\n\nRun the earlier phase to completion first, and let it finish before ' +
      'starting this one.\n\nExamples:\n' +
      work.blocked.slice(0, 8).map(b => '  - ' + b).join('\n') +
      (work.blocked.length > 8 ? '\n  ... and ' + (work.blocked.length - 8) + ' more' : '') +
      '\n\nIf enrollments exist in the portal but not in the manifest, run ' +
      'Developer -> Repair Manifest first.');
    return;
  }

  if (!work.items.length) {
    uiAlert(title, 'Nothing to do — everything in the plan is already in the manifest.\n\n' +
      work.skipped + ' record(s) already seeded.');
    return;
  }

  // Confirm BEFORE taking the lock. Holding a script lock while a dialog waits for a human blocks
  // every other phase and, worse, lets a second execution race this one on the manifest.
  if (!confirmWrite_(title, work)) return;

  return withLock(function () {
    const runId = newRunId();
    const result = fn.execute(work, runId, plan);

    logAction({
      run_id: runId, action: title, phase: fn.phase, platform: 'learnupon',
      object_type: fn.phase, intended: work.items.length,
      succeeded: result.succeeded, failed: result.failed,
      notes: result.notes.slice(0, 3).join(' | ')
    });

    uiAlert(title + ' — done',
      'Portal:   ' + environmentLabel() + '\n' +
      'Scenario: ' + scopeLabel() + '\n\n' +
      'Created:  ' + result.succeeded + '\n' +
      'Failed:   ' + result.failed + '\n' +
      'Skipped:  ' + work.skipped + ' (already in the manifest)\n\n' +
      (result.notes.length
        ? 'Problems:\n' + result.notes.slice(0, 10).map(n => '  - ' + n).join('\n') +
          (result.notes.length > 10 ? '\n  ... and ' + (result.notes.length - 10) + ' more' : '')
        : 'No errors.') +
      '\n\nEvery created record is on _Manifest. See _Log for the run summary.');
  });
}

/** Confirmation names the portal, because seeding ACME by reflex is the mistake to prevent. */
function confirmWrite_(title, work, portalLabel) {
  const env = currentEnvironment();
  const message = title + '\n\n' +
    'PORTAL:   ' + (portalLabel || environmentLabel()) + '\n' +
    'SCENARIO: ' + scopeLabel() + '\n\n' +
    'About to create ' + work.items.length + ' ' + work.noun + '.\n' +
    (work.skipped ? work.skipped + ' already exist and will be skipped.\n' : '') +
    (work.preview.length ? '\nFirst few:\n' + work.preview.slice(0, 5).map(p => '  ' + p).join('\n') : '');

  if (env === 'demo') {
    return uiConfirmTyped('SEED DEMO',
      message + '\n\nThis is the ACME demo portal, not the test portal.');
  }
  const ui = SpreadsheetApp.getUi();
  return ui.alert('Confirm', message, ui.ButtonSet.OK_CANCEL) === ui.Button.OK;
}

function luPost_(path, payload, opts) {
  return luRequest_('post', path, payload, opts);
}

/** Deterministic but never stored anywhere. These are demo-portal learners who never log in. */
function seedPassword_(email, seed) {
  return 'Lu' + hash32(email + '|pw|' + seed).toString(36) + '!Aa9';
}

function idFrom_(res, keys) {
  if (!res || !res.body) return null;
  const direct = pick_(res.body, keys || ['id']);
  if (direct) return String(direct);
  const nested = firstArrayIn_(res.body)[0];
  return nested && nested.id ? String(nested.id) : null;
}

// ---------------------------------------------------------------------------
// Phase 1 — users, groups, memberships
// ---------------------------------------------------------------------------

const phaseUsersGroups_ = {
  phase: 'users-groups',

  build: function (plan, index) {
    const items = [];
    let skipped = 0;

    plan.learnupon.groups.forEach(g => {
      if (index[g.natural_key]) { skipped++; return; }
      items.push({ kind: 'group', rec: g });
    });
    plan.learnupon.users.forEach(u => {
      if (index[u.natural_key]) { skipped++; return; }
      items.push({ kind: 'user', rec: u });
    });
    plan.learnupon.memberships.forEach(m => {
      if (index[m.natural_key]) { skipped++; return; }
      items.push({ kind: 'membership', rec: m });
    });

    return {
      items: items, skipped: skipped, noun: 'groups, users and memberships',
      preview: items.slice(0, 5).map(i =>
        i.kind + ': ' + (i.rec.title || i.rec.email || i.rec.natural_key))
    };
  },

  execute: function (work, runId, plan) {
    const notes = [];
    let succeeded = 0, failed = 0;
    const settings = getSettings();
    const seed = String(settings.prng_seed);
    const jobLabel = String(settings.job_title_field_label || '').trim();
    const tagLabel = String(settings.demo_source_field_label || '').trim();
    const tagValue = String(settings.demo_tag || 'MCP-DEMO');

    // Rebuilt as we go so memberships can resolve the ids created moments earlier in this same run.
    const index = manifestIndex();

    work.items.forEach(item => {
      try {
        if (item.kind === 'group') {
          const g = item.rec;
          let id = findGroupIdByTitle_(g.title);
          if (!id) {
            const res = luPost_('groups', { Group: { title: g.title,
              description: 'Demo account group created by the MCP seeder.' } });
            id = idFrom_(res);
          }
          if (!id) throw new Error('no group id returned');
          manifestAppend(runId, [{ object_type: 'group', class: 'persistent', external_id: id,
            natural_key: g.natural_key, use_case: g.use_case, extra: g.title }]);
          index[g.natural_key] = { external_id: id };
          succeeded++;

        } else if (item.kind === 'user') {
          const u = item.rec;
          const custom = {};
          if (jobLabel && u.job_title) custom[jobLabel] = u.job_title;
          if (tagLabel) custom[tagLabel] = tagValue;

          let id = findUserIdByEmail_(u.email);
          if (id) {
            // Adopt rather than duplicate. Users are persistent and shared across re-seeds.
            notes.push('adopted existing user ' + u.email);
            if (Object.keys(custom).length) {
              luRequest_('put', 'users/' + id, { User: { CustomData: custom } }, { raw: true });
            }
          } else {
            const res = luPost_('users', { User: {
              email: u.email, first_name: u.first_name, last_name: u.last_name,
              password: seedPassword_(u.email, seed), language: 'en', user_type: 'learner',
              CustomData: custom
            } });
            id = idFrom_(res);
          }
          if (!id) throw new Error('no user id returned');
          manifestAppend(runId, [{ object_type: 'user', class: 'persistent', external_id: id,
            natural_key: u.natural_key, use_case: u.use_case, extra: u.email }]);
          index[u.natural_key] = { external_id: id };
          succeeded++;

        } else {
          const m = item.rec;
          const groupId = manifestIdFor(index, m.group_natural_key);
          const userId = manifestIdFor(index, m.user_natural_key);
          if (!groupId || !userId) throw new Error('group or user not seeded yet');
          const res = luPost_('group_memberships',
            { GroupMembership: { group_id: Number(groupId), user_id: Number(userId) } });
          const id = idFrom_(res) || (groupId + ':' + userId);
          manifestAppend(runId, [{ object_type: 'membership', class: 'persistent', external_id: id,
            natural_key: m.natural_key, use_case: m.use_case, parent_external_id: groupId,
            extra: userId }]);
          index[m.natural_key] = { external_id: id };
          succeeded++;
        }
      } catch (e) {
        failed++;
        notes.push(item.kind + ' ' + (item.rec.email || item.rec.title || item.rec.natural_key) +
          ': ' + String(e.message).slice(0, 160));
      }
    });

    return { succeeded: succeeded, failed: failed, notes: notes };
  }
};

/** Filtered reads are never trusted — confirm the record returned is the one asked for. */
function findUserIdByEmail_(email) {
  try {
    const body = luGet_('users/search?email=' + encodeURIComponent(email)).body;
    const match = firstArrayIn_(body, ['user', 'users'])
      .filter(u => String(u.email || '').toLowerCase() === String(email).toLowerCase())[0];
    return match ? String(match.id) : null;
  } catch (e) {
    return null;
  }
}

/**
 * reference_code is our invisible course tag. LearnUpon ignores ?reference_code= as a filter and
 * returns the whole catalogue, so match client-side — see API quirk 3.
 */
/** Finds a user's existing enrollment on a course. Used only on the conflict path. */
function findEnrollmentId_(email, courseId) {
  try {
    const match = firstArrayIn_(luGet_('enrollments/search?email=' + encodeURIComponent(email)).body,
      ['enrollments'])
      .filter(e => String(e.course_id) === String(courseId))[0];
    return match ? String(match.id) : null;
  } catch (e) {
    return null;
  }
}

function findCourseIdByReferenceCode_(refCode) {
  if (!refCode) return null;
  try {
    const match = firstArrayIn_(luGet_('courses').body, ['courses'])
      .filter(c => String(c.reference_code || '').trim() === String(refCode).trim())[0];
    return match ? String(match.id) : null;
  } catch (e) {
    return null;
  }
}

function findGroupIdByTitle_(title) {
  try {
    const body = luGet_('groups?title=' + encodeURIComponent(title)).body;
    const match = firstArrayIn_(body, ['groups', 'group'])
      .filter(g => String(g.title || '').trim() === String(title).trim())[0];
    return match ? String(match.id) : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — courses
// ---------------------------------------------------------------------------

const phaseCourses_ = {
  phase: 'courses',

  build: function (plan, index) {
    const items = [];
    let skipped = 0;
    plan.learnupon.courses.forEach(c => {
      if (index[c.natural_key]) { skipped++; return; }
      items.push({ kind: 'course', rec: c });
    });

    // Module ids are PORTAL-SPECIFIC. A scenario file written against the sandbox carries ids that
    // do not exist in ACME, and add_module fails for every course. Checking up front costs one
    // call and turns a confusing cascade into a sentence.
    const blocked = [];
    if (items.length) {
      const valid = {};
      try {
        firstArrayIn_(luGet_('modules').body, ['modules']).forEach(m => {
          valid[String(pick_(m, ['id']))] = String(pick_(m, ['component_type', 'type']) || '?');
        });
      } catch (e) {
        blocked.push('could not list modules in this portal: ' + String(e.message).slice(0, 120));
      }

      const fallback = String(getSetting('default_source_module_id', '')).trim();
      if (Object.keys(valid).length) {
        items.forEach(i => {
          const own = String(i.rec.source_module_id || '').trim();
          if (own && valid[own]) { i.moduleId = own; return; }
          if (fallback && valid[fallback]) {
            i.moduleId = fallback;
            i.usedFallback = own || '(blank)';
            return;
          }
          blocked.push(i.rec.title + ': module ' + (own || '(blank)') + ' does not exist in ' +
            environmentLabel() + (fallback ? ', and Settings.default_source_module_id (' +
            fallback + ') does not either' : ', and Settings.default_source_module_id is blank'));
        });
        // An "ilt session" module carries its own seat capacity and fails every enrollment.
        items.forEach(i => {
          if (i.moduleId && valid[i.moduleId] === 'ilt session') {
            blocked.push(i.rec.title + ': module ' + i.moduleId + ' is an "ilt session". Live ' +
              'sessions have their own seat count and every enrollment fails with "course ' +
              'capacity reached". Pick a different module.');
          }
        });
      }
    }

    return {
      items: items, skipped: skipped, noun: 'courses', blockedCourses: blocked,
      preview: items.map(i => i.rec.title + '  [' + i.rec.reference_code + ']' +
        (i.usedFallback ? '  (module ' + i.moduleId + ' from Settings)' : ''))
    };
  },

  execute: function (work, runId) {
    const notes = [];
    let succeeded = 0, failed = 0;
    const ownerId = String(getSetting('course_owner_id', '')).trim();

    work.items.forEach(item => {
      const c = item.rec;
      try {
        if (!ownerId) throw new Error('Settings.course_owner_id is blank');

        // Adopt before creating, exactly as users and groups do. Without this, a lost or cleared
        // manifest produces a SECOND course with the same title, and two identically named courses
        // make every demo answer ambiguous — the same failure validation already blocks in the sheet.
        let id = findCourseIdByReferenceCode_(c.reference_code);
        let adopted = false;
        if (id) {
          adopted = true;
          notes.push('adopted existing course ' + c.reference_code + ' (id ' + id + ')');
        } else {
          // Build, do not clone: a clone is named "<source> - Copy" and is async, where this sets
          // the exact title and our reference_code tag in one synchronous call.
          const res = luPost_('courses', { Course: {
            name: c.title, owner_id: Number(ownerId), reference_code: c.reference_code,
            description: 'Required onboarding training.'
          } });
          id = idFrom_(res);
        }
        if (!id) throw new Error('no course id returned');

        manifestAppend(runId, [{ object_type: 'course', class: 'persistent', external_id: id,
          natural_key: c.natural_key, use_case: c.use_case, extra: c.reference_code }]);

        // Content, then publish. A course with no modules cannot be enrolled on at all, so a
        // failure here is NOT cosmetic — it leaves an empty draft that every later enrollment
        // rejects with "internal error". Reporting it as created is how one wrong module id
        // turned into 188 failed enrollments with no clue where the fault was.
        if (!adopted) {
          const moduleId = Number(item.moduleId || c.source_module_id);
          const add = luPost_('courses/add_module',
            { course_id: Number(id), module_id: moduleId }, { raw: true });
          if (add.code >= 400) {
            throw new Error('add_module(' + moduleId + ') returned ' + add.code + ' ' +
              String(add.raw || '').slice(0, 140) + ' — the course exists but is an empty draft ' +
              'and nothing can be enrolled on it. Run Developer -> Repair Courses after fixing ' +
              'the module id.');
          }
          const pub = luPost_('courses/publish', { course_id: Number(id) }, { raw: true });
          if (pub.code >= 400) {
            throw new Error('publish returned ' + pub.code + ' ' +
              String(pub.raw || '').slice(0, 140) + ' — the course is still a draft. Draft courses ' +
              'are invisible to GET /courses and cannot be enrolled on.');
          }
        }

        succeeded++;
      } catch (e) {
        failed++;
        notes.push(c.title + ': ' + String(e.message).slice(0, 160));
      }
    });

    return { succeeded: succeeded, failed: failed, notes: notes };
  }
};

// ---------------------------------------------------------------------------
// Phase 3 — enrollments
// ---------------------------------------------------------------------------

const phaseEnrollments_ = {
  phase: 'enrollments',

  build: function (plan, index) {
    const items = [];
    let skipped = 0;
    plan.learnupon.enrollments.forEach(e => {
      if (index[e.natural_key]) { skipped++; return; }
      items.push({ kind: 'enrollment', rec: e });
    });
    return {
      items: items, skipped: skipped, noun: 'enrollments',
      preview: items.slice(0, 5).map(i => i.rec.email + ' -> ' + i.rec.course_title +
        (i.rec.due_date ? '  due ' + ymd(i.rec.due_date) : ''))
    };
  },

  execute: function (work, runId) {
    const notes = [];
    let succeeded = 0, failed = 0;
    const index = manifestIndex();

    work.items.forEach(item => {
      const e = item.rec;
      try {
        const courseId = manifestIdFor(index, e.course_natural_key);
        if (!courseId) throw new Error('course not seeded — run Seed Courses first');

        const payload = { Enrollment: { email: e.email, course_id: Number(courseId) } };
        if (e.due_date) payload.Enrollment.due_date = ymd(e.due_date);

        const res = luPost_('enrollments', payload, { raw: true });
        let id = idFrom_(res);

        // Adopt rather than fail, the same way users, groups, courses and completions do. A user
        // already enrolled on the course means the record exists and only the ledger is missing —
        // and without the ledger row nothing downstream can complete, refresh or reset it.
        if (!id && res.code >= 400) {
          id = findEnrollmentId_(e.email, courseId);
          if (id) notes.push('adopted existing enrollment for ' + e.email + ' / ' + e.course_key);
        }
        if (!id) {
          throw new Error(res.code >= 400
            ? 'HTTP ' + res.code + ' ' + String(res.raw || '').slice(0, 150)
            : 'no enrollment id returned');
        }

        manifestAppend(runId, [{ object_type: 'enrollment',
          // Completed enrollments become undeletable, so class is set when the completion lands,
          // not here. Everything starts life as disposable.
          class: 'disposable', external_id: id, natural_key: e.natural_key,
          use_case: e.use_case, parent_external_id: courseId, extra: e.email }]);
        succeeded++;
      } catch (err) {
        failed++;
        notes.push(e.email + ' / ' + e.course_key + ': ' + String(err.message).slice(0, 160));
      }
    });

    return { succeeded: succeeded, failed: failed, notes: notes };
  }
};

// ---------------------------------------------------------------------------
// Phase 4 — completions
// ---------------------------------------------------------------------------

const phaseCompletions_ = {
  phase: 'completions',

  build: function (plan, index) {
    const items = [];
    let skipped = 0;
    const blocked = [];
    plan.learnupon.enrollments.forEach(e => {
      if (e.status !== 'completed') return;
      if (index['done:' + e.natural_key]) { skipped++; return; }
      if (!index[e.natural_key]) {
        // The enrollment is not in the manifest, so we have nothing to complete. This used to
        // `return` silently — which once reported "Created: 7, Failed: 0, No errors" while dropping
        // 185 completions on the floor. Never drop work quietly in a phase whose output is permanent.
        blocked.push(e.email + ' / ' + e.course_key);
        return;
      }
      items.push({ kind: 'completion', rec: e });
    });
    return {
      items: items, skipped: skipped, blocked: blocked, noun: 'backdated completions',
      preview: items.slice(0, 5).map(i => i.rec.email + ' -> ' + i.rec.course_title +
        '  completed ' + ymd(i.rec.date_completed))
    };
  },

  execute: function (work, runId) {
    const notes = [];
    let succeeded = 0, failed = 0;
    const index = manifestIndex();

    work.items.forEach(item => {
      const e = item.rec;
      try {
        const enrollmentId = manifestIdFor(index, e.natural_key);
        if (!enrollmentId) throw new Error('enrollment not in the manifest');
        if (!e.date_completed) throw new Error('no completion date resolved');

        // percentage must be omitted for "completed" — it is a score, valid only with passed/failed.
        const res = luPost_('markcompletes', { Markcomplete: {
          enrollment_id: Number(enrollmentId),
          date_completed: isoAtMidday(e.date_completed),
          status: 'completed'
        } }, { raw: true });

        let id = idFrom_(res);
        // The completion already exists but our ledger lost its row — adopt it, exactly as users,
        // groups and courses do. Reporting this as a failure would be wrong twice over: the portal
        // is correct, and leaving the row out means reset cannot tell this enrollment is permanent.
        if (!id && res.code === 400 && /already exist/i.test(String(res.raw || ''))) {
          id = 'pre-existing';
          notes.push('adopted existing completion for ' + e.email + ' / ' + e.course_key);
        }
        if (!id) {
          throw new Error(res.code >= 400
            ? 'HTTP ' + res.code + ' ' + String(res.raw || '').slice(0, 160)
            : 'no markcomplete id returned');
        }

        // A completion cannot be undone, so record it as its own permanent manifest row. Reset
        // reads this to know what it must NOT claim to have removed.
        manifestAppend(runId, [{ object_type: 'completion', class: 'permanent', external_id: id,
          natural_key: 'done:' + e.natural_key, use_case: e.use_case,
          parent_external_id: enrollmentId, extra: ymd(e.date_completed) }]);
        succeeded++;
      } catch (err) {
        failed++;
        notes.push(e.email + ' / ' + e.course_key + ': ' + String(err.message).slice(0, 160));
      }
    });

    return { succeeded: succeeded, failed: failed, notes: notes };
  }
};
