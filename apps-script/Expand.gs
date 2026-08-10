/**
 * Expand.gs — turns declarations into a concrete record plan.
 *
 * expand() is pure: no API calls, no writes. Dry-run previews and the seeder consume the same plan,
 * so what you see in Preview is exactly what gets created.
 *
 * Natural keys are the identity of a record across runs, independent of platform IDs:
 *
 *   user:person:alderfield.dana      a named persona
 *   user:filler:alderfield:03        a generated learner
 *   group:alderfield                 the account's LearnUpon group
 *   mem:alderfield:user:filler:...   a group membership
 *   course:nce-getting-started       a cloned course
 *   enr:nce-getting-started:user:... an enrollment
 */

// Deliberately excludes "Platform Administrator": Story 3 claims Dana Reyes is the only person
// holding platform admin rights, and a generated learner sharing her title would contradict it.
const ADMIN_TITLES = ['Systems Administrator', 'IT Administrator', 'Technical Administrator'];
const LEARNER_TITLES = ['Operations Analyst', 'Support Specialist', 'Team Lead',
  'Account Coordinator', 'Project Coordinator', 'Business Analyst'];

function loadWorkbook() {
  return {
    settings: getSettings(),
    scenarios: tabRows(TAB.SCENARIOS),
    accounts: tabRows(TAB.ACCOUNTS),
    people: tabRows(TAB.PEOPLE),
    courses: tabRows(TAB.COURSES),
    enrollments: tabRows(TAB.ENROLLMENTS),
    personaStates: tabRows(TAB.PERSONA_STATES),
    ticketCategories: tabRows(TAB.TICKET_CATEGORIES),
    tickets: tabRows(TAB.TICKETS),
    deals: tabRows(TAB.DEALS),
    manifest: tabRows(TAB.MANIFEST)
  };
}

function truthy_(v) {
  return v === true || String(v).trim().toUpperCase() === 'TRUE';
}

function num_(v, dflt) {
  if (v === '' || v === null || v === undefined) return dflt;
  const n = Number(v);
  return isNaN(n) ? dflt : n;
}

// ---------------------------------------------------------------------------
// expand
// ---------------------------------------------------------------------------

function expand(wb) {
  const settings = wb.settings;
  const seed = String(settings.prng_seed === undefined ? '0' : settings.prng_seed);
  const T = resolveAnchor(settings);
  const warnings = [];

  const plan = {
    anchor: ymd(T),
    seed: seed,
    environment: String(settings.environment || 'test'),
    learnupon: { users: [], groups: [], memberships: [], courses: [], enrollments: [] },
    hubspot: { companies: [], contacts: [], tickets: [], deals: [] },
    // Spike 1b: the API cannot produce an in-progress enrollment. The seeder creates these as
    // not-started and lists them here so a human can open them in the UI. Without this list the
    // plan would claim a state the portal will never show.
    manualTouches: [],
    stats: { byAccount: [] },
    warnings: warnings
  };

  const accountByKey = {};
  wb.accounts.forEach(a => { if (a.account_key) accountByKey[a.account_key] = a; });
  const courseByKey = {};
  wb.courses.forEach(c => { if (c.course_key) courseByKey[c.course_key] = c; });

  const personasByAccount = {};
  wb.people.forEach(p => {
    if (!p.account_key) return;
    (personasByAccount[p.account_key] = personasByAccount[p.account_key] || []).push(p);
  });

  // The manifest is the source of truth for a filler's email once it exists — the name pool could
  // change, and we must never create a second user for the same natural key.
  const emailByNaturalKey = {};
  (wb.manifest || []).forEach(m => {
    if (m.object_type === 'user' && m.natural_key && m.extra) {
      emailByNaturalKey[m.natural_key] = String(m.extra).trim().toLowerCase();
    }
  });

  // --- users, groups, memberships -----------------------------------------
  const usersByAccount = {};
  wb.accounts.forEach(acct => {
    const built = buildAccountUsers_(acct, personasByAccount[acct.account_key] || [],
      seed, emailByNaturalKey, warnings);
    usersByAccount[acct.account_key] = built;
    built.forEach(u => plan.learnupon.users.push(u));

    const title = String(acct.lu_group_title || '').trim() ||
      String(settings.group_title_prefix || 'Customer: ') + String(acct.company_name || '').trim();
    plan.learnupon.groups.push({
      natural_key: 'group:' + acct.account_key,
      title: title,
      account_key: acct.account_key,
      use_case: acct.use_case
    });
    built.forEach(u => plan.learnupon.memberships.push({
      natural_key: 'mem:' + acct.account_key + ':' + u.natural_key,
      group_natural_key: 'group:' + acct.account_key,
      user_natural_key: u.natural_key,
      account_key: acct.account_key,
      use_case: acct.use_case
    }));
  });

  // --- courses -------------------------------------------------------------
  wb.courses.forEach(c => {
    plan.learnupon.courses.push({
      natural_key: 'course:' + c.course_key,
      course_key: c.course_key,
      title: String(c.title || '').trim(),
      reference_code: String(c.reference_code || '').trim(),
      source_module_id: c.source_module_id,
      use_case: c.use_case
    });
  });

  // --- persona state pins --------------------------------------------------
  const pinsByCourseAndPerson = {};
  wb.personaStates.forEach(ps => {
    if (!ps.person_key || !ps.course_key) return;
    pinsByCourseAndPerson[ps.course_key + '|' + ps.person_key] = ps;
  });

  // --- enrollments ---------------------------------------------------------
  wb.enrollments.forEach(row => {
    const acct = accountByKey[row.account_key];
    const course = courseByKey[row.course_key];
    if (!acct || !course) return; // Validate.gs reports this as an error

    let ctx;
    try {
      ctx = accountDateContext(acct, T);
    } catch (e) {
      warnings.push('Enrollments row ' + row._row + ': ' + e.message);
      return;
    }

    const audience = String(row.audience || 'all').trim();
    const all = usersByAccount[acct.account_key] || [];
    const candidates = audience === 'admins' ? all.filter(u => u.is_admin) : all;

    // An explicit override wins, including zero — "this account enrolled nobody" is a finding.
    let want = num_(row.enroll_count_override, null);
    if (want === null) want = num_(row.enroll_count, null);
    if (want === null) want = num_(audience === 'admins' ? acct.admin_count : acct.user_count, 0);
    if (candidates.length < want) {
      warnings.push('Enrollments row ' + row._row + ' (' + row.account_key + '/' + row.course_key +
        '): wants ' + want + ' ' + audience + ' but only ' + candidates.length +
        ' exist — enrolling ' + candidates.length + '.');
      want = candidates.length;
    }
    const selected = candidates.slice(0, want);

    let dueSpec = null, completeSpec = null, lastSpec = null, pctSpec = null;
    try {
      dueSpec = parseOffsetSpec(row.due_offset);
      completeSpec = parseOffsetSpec(row.complete_offset);
      lastSpec = parseOffsetSpec(row.last_access_offset);
      pctSpec = parseNumberSpec(row.in_progress_pct);
    } catch (e) {
      warnings.push('Enrollments row ' + row._row + ': ' + e.message);
      return;
    }

    // Pins win; declared counts fill what is left.
    const completedTarget = num_(row.completed_count, 0);
    const inProgressTarget = num_(row.in_progress_count, 0);
    const assigned = {};
    let pinnedCompleted = 0, pinnedInProgress = 0;

    selected.forEach(u => {
      if (!u.person_key) return;
      const pin = pinsByCourseAndPerson[row.course_key + '|' + u.person_key];
      if (!pin) return;
      const status = String(pin.status || '').trim();
      assigned[u.natural_key] = { status: status, pin: pin };
      if (status === 'completed') pinnedCompleted++;
      if (status === 'in_progress') pinnedInProgress++;
    });

    const unpinned = orderByHash(selected.filter(u => !assigned[u.natural_key]),
      u => 'assign|' + row.course_key + '|' + u.natural_key, seed);

    let needCompleted = Math.max(0, completedTarget - pinnedCompleted);
    let needInProgress = Math.max(0, inProgressTarget - pinnedInProgress);
    unpinned.forEach(u => {
      let status = 'not_started';
      if (needCompleted > 0) { status = 'completed'; needCompleted--; }
      else if (needInProgress > 0) { status = 'in_progress'; needInProgress--; }
      assigned[u.natural_key] = { status: status, pin: null };
    });

    selected.forEach(u => {
      const a = assigned[u.natural_key] || { status: 'not_started', pin: null };
      const nk = 'enr:' + row.course_key + ':' + u.natural_key;
      const pin = a.pin;

      const e = {
        natural_key: nk,
        user_natural_key: u.natural_key,
        course_natural_key: 'course:' + course.course_key,
        course_key: course.course_key,
        course_title: course.title,
        account_key: acct.account_key,
        use_case: row.use_case || acct.use_case,
        email: u.email,
        full_name: u.first_name + ' ' + u.last_name,
        is_admin: u.is_admin,
        status: a.status,
        due_date: null,
        date_completed: null,
        date_last_accessed: null,
        percentage: null,
        overdue: false,
        source_row: row._row
      };

      try {
        e.due_date = resolveOffsetSpec(dueSpec, ctx, 'due|' + nk, seed);

        if (a.status === 'completed') {
          const spec = (pin && pin.complete_offset) ? parseOffsetSpec(pin.complete_offset) : completeSpec;
          let d = resolveOffsetSpec(spec, ctx, 'cmp|' + nk, seed);
          if (d && d.getTime() > T.getTime()) {
            warnings.push('Enrollments row ' + row._row + ': a completion resolved to ' + ymd(d) +
              ', in the future — clamped to ' + ymd(T) + '. Tighten complete_offset.');
            d = T;
          }
          e.date_completed = d;
          e.percentage = 100;

        } else if (a.status === 'in_progress') {
          const pctFromPin = pin ? num_(pin.percentage, null) : null;
          e.percentage = pctFromPin !== null ? pctFromPin
            : (resolveNumberSpec(pctSpec, 'pct|' + nk, seed) || 25);
          const spec = (pin && pin.last_access_offset) ? parseOffsetSpec(pin.last_access_offset) : lastSpec;
          let d = resolveOffsetSpec(spec, ctx, 'lat|' + nk, seed);
          if (d && d.getTime() > T.getTime()) d = T;
          e.date_last_accessed = d;
        }
      } catch (err) {
        warnings.push('Enrollments row ' + row._row + ' (' + u.email + '): ' + err.message);
        return;
      }

      e.overdue = a.status !== 'completed' && !!e.due_date && e.due_date.getTime() < T.getTime();
      if (a.status === 'in_progress') {
        e.needs_manual_touch = true;
        plan.manualTouches.push({
          email: e.email, full_name: e.full_name, course_title: e.course_title,
          account_key: e.account_key, percentage: e.percentage,
          date_last_accessed: e.date_last_accessed, natural_key: nk
        });
      }
      plan.learnupon.enrollments.push(e);
    });
  });

  // --- HubSpot -------------------------------------------------------------
  expandHubSpot_(wb, plan, T, seed, accountByKey, personasByAccount, warnings);

  plan.stats.byAccount = accountStats_(wb.accounts, plan);
  return plan;
}

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

/**
 * Companies, contacts, tickets and deals.
 *
 * The cross-system join is the EMAIL DOMAIN and nothing else — a HubSpot contact matches a
 * LearnUpon user because the addresses are identical, which is why People.email is computed rather
 * than typed. Get that wrong and the demo's central question ("are the people filing tickets the
 * ones who skipped the training?") silently returns nothing.
 *
 * Contacts are the named personas only. Filler learners exist in LearnUpon to make the completion
 * denominators real, but a HubSpot contact for each would add 60 records that no story reads.
 */
function expandHubSpot_(wb, plan, T, seed, accountByKey, personasByAccount, warnings) {
  const hs = plan.hubspot;

  const catByKey = {};
  wb.ticketCategories.forEach(c => { if (c.category_key) catByKey[c.category_key] = c; });

  const ctxByAccount = {};
  wb.accounts.forEach(acct => {
    if (!acct.account_key) return;
    try {
      ctxByAccount[acct.account_key] = accountDateContext(acct, T);
    } catch (e) {
      warnings.push('Accounts ' + acct.account_key + ': ' + e.message);
      return;
    }
    const ctx = ctxByAccount[acct.account_key];

    hs.companies.push({
      natural_key: 'hs:company:' + acct.account_key,
      account_key: acct.account_key,
      use_case: acct.use_case,
      name: String(acct.company_name || '').trim(),
      domain: String(acct.domain || '').trim().toLowerCase(),
      industry: String(acct.industry || '').trim(),
      arr: num_(acct.arr, null),
      plan_tier: String(acct.plan_tier || '').trim(),
      csm_owner_email: String(acct.csm_owner_email || '').trim(),
      onboarding_start_date: ctx.S,
      target_go_live_date: ctx.G,
      actual_go_live_date: ctx.A || null
    });
  });

  // --- contacts ------------------------------------------------------------
  const contactByPersonKey = {};
  wb.people.forEach(p => {
    if (!p.person_key || !p.account_key) return;
    const acct = accountByKey[p.account_key];
    if (!acct) return;   // Validate.gs reports the dangling reference
    const c = {
      natural_key: 'hs:contact:' + p.person_key,
      person_key: p.person_key,
      account_key: p.account_key,
      use_case: p.use_case || acct.use_case,
      email: String(p.email || '').trim().toLowerCase(),
      first_name: String(p.first_name || '').trim(),
      last_name: String(p.last_name || '').trim(),
      job_title: String(p.job_title || '').trim()
    };
    contactByPersonKey[p.person_key] = c;
    hs.contacts.push(c);
  });

  // --- tickets -------------------------------------------------------------
  wb.tickets.forEach(row => {
    if (!row.account_key || !row.category_key) return;
    const acct = accountByKey[row.account_key];
    const cat = catByKey[row.category_key];
    const ctx = ctxByAccount[row.account_key];
    if (!acct || !cat || !ctx) return;

    const count = num_(row.count, 0);
    if (count <= 0) return;

    let windowSpec;
    try {
      // window_start..window_end is an ordinary range spec, so each ticket lands on its own day
      // inside it. Declaring 34 tickets over 90 days produces a scatter, not 34 identical dates.
      windowSpec = parseOffsetSpec(String(row.window_start).trim() + '..' +
        String(row.window_end).trim());
    } catch (e) {
      warnings.push('Tickets row ' + row._row + ': ' + e.message);
      return;
    }

    const filers = String(row.contact_person_keys || '').split(',')
      .map(k => k.trim()).filter(k => k)
      .map(k => contactByPersonKey[k])
      .filter(c => c);
    if (!filers.length) {
      const fallback = (personasByAccount[row.account_key] || [])
        .map(p => contactByPersonKey[p.person_key]).filter(c => c);
      filers.push.apply(filers, fallback);
    }
    if (!filers.length) {
      warnings.push('Tickets row ' + row._row + ' (' + row.account_key + '/' + row.category_key +
        '): no contact to file them, so ' + count + ' ticket(s) will have no requester.');
    }

    const subjects = String(cat.subject_templates || '').split('|')
      .map(t => t.trim()).filter(t => t);

    for (let i = 0; i < count; i++) {
      const nk = 'hs:ticket:' + row.row_id + ':' + pad2_(i + 1);
      let created;
      try {
        created = resolveOffsetSpec(windowSpec, ctx, 'tkt|' + nk, seed);
      } catch (e) {
        warnings.push('Tickets row ' + row._row + ': ' + e.message);
        break;
      }
      const filer = filers.length ? filers[i % filers.length] : null;
      const subject = subjects.length
        ? subjects[hash32(nk + '|subj', seed) % subjects.length]
        : String(cat.label || row.category_key) + ' question';

      hs.tickets.push({
        natural_key: nk,
        row_id: row.row_id,
        account_key: row.account_key,
        use_case: row.use_case || acct.use_case,
        category_key: row.category_key,
        category_label: String(cat.label || row.category_key),
        subject: subject,
        company_name: String(acct.company_name || '').trim(),
        contact_natural_key: filer ? filer.natural_key : null,
        contact_email: filer ? filer.email : null,
        priority: String(row.priority || 'MEDIUM').trim().toUpperCase(),
        stage_label: String(row.status || '').trim(),
        created_at: created,
        resolution_hours: num_(row.resolution_hours, null)
      });
    }
  });

  // --- deals ---------------------------------------------------------------
  wb.deals.forEach(row => {
    if (!row.account_key) return;
    const acct = accountByKey[row.account_key];
    const ctx = ctxByAccount[row.account_key];
    if (!acct || !ctx) return;
    let close;
    try {
      close = resolveOffsetSpec(parseOffsetSpec(row.close_offset), ctx, 'deal|' + row.row_id, seed);
    } catch (e) {
      warnings.push('Deals row ' + row._row + ': ' + e.message);
      return;
    }
    hs.deals.push({
      natural_key: 'hs:deal:' + row.row_id,
      row_id: row.row_id,
      account_key: row.account_key,
      use_case: row.use_case || acct.use_case,
      name: String(acct.company_name || '').trim() + ' — ' +
        String(row.deal_type || 'renewal').trim().replace(/^./, ch => ch.toUpperCase()),
      pipeline_label: String(row.pipeline || '').trim(),
      stage_label: String(row.stage || '').trim(),
      amount: num_(row.amount, null),
      deal_type: String(row.deal_type || '').trim(),
      close_date: close
    });
  });
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/**
 * Narrows a plan to one scenario.
 *
 * expand() always builds every scenario, because validation needs to see across all three to catch
 * collisions. Every ACTION then works on a narrowed copy, so one person's Seed, Reset or Refresh
 * cannot reach into another person's accounts.
 *
 * Courses are deliberately NOT narrowed away: they are shared infrastructure, one record per title
 * across all scenarios, and Reset never deletes them.
 */
function planForScope_(plan, scope) {
  if (scope === 'all') return plan;

  const useCaseByAccount = {};
  plan.stats.byAccount.forEach(a => { useCaseByAccount[a.account_key] = a.use_case; });
  const mine = key => inScope_(useCaseByAccount[key], scope);

  const enrollments = plan.learnupon.enrollments.filter(e => mine(e.account_key));
  const courseKeysUsed = {};
  enrollments.forEach(e => { courseKeysUsed[e.course_key] = true; });

  const scoped = {
    anchor: plan.anchor,
    seed: plan.seed,
    environment: plan.environment,
    scope: scope,
    learnupon: {
      users: plan.learnupon.users.filter(u => mine(u.account_key)),
      groups: plan.learnupon.groups.filter(g => mine(g.account_key)),
      memberships: plan.learnupon.memberships.filter(m => mine(m.account_key)),
      courses: plan.learnupon.courses.filter(c =>
        inScope_(c.use_case, scope) || courseKeysUsed[c.course_key]),
      enrollments: enrollments
    },
    hubspot: {
      companies: plan.hubspot.companies.filter(c => mine(c.account_key)),
      contacts: plan.hubspot.contacts.filter(c => mine(c.account_key)),
      tickets: plan.hubspot.tickets.filter(t => mine(t.account_key)),
      deals: plan.hubspot.deals.filter(d => mine(d.account_key))
    },
    manualTouches: plan.manualTouches.filter(m => mine(m.account_key)),
    stats: { byAccount: plan.stats.byAccount.filter(a => mine(a.account_key)) },
    warnings: plan.warnings
  };
  return scoped;
}

/** The plan for whatever scenario the sheet is currently pointed at. */
function scopedPlan() {
  return planForScope_(expand(loadWorkbook()), activeUseCase());
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function buildAccountUsers_(acct, personas, seed, emailByNaturalKey, warnings) {
  const users = [];
  const taken = {};
  const domain = String(acct.domain || '').trim().toLowerCase();

  personas.forEach(p => {
    const email = String(p.email || '').trim().toLowerCase();
    users.push({
      natural_key: 'user:person:' + p.person_key,
      person_key: p.person_key,
      first_name: String(p.first_name || '').trim(),
      last_name: String(p.last_name || '').trim(),
      email: email,
      job_title: String(p.job_title || '').trim(),
      is_admin: truthy_(p.is_admin),
      account_key: acct.account_key,
      use_case: acct.use_case,
      generated: false
    });
    taken[email] = true;
  });

  const totalWanted = num_(acct.user_count, personas.length);
  const adminsWanted = num_(acct.admin_count, 0);
  const personaAdmins = users.filter(u => u.is_admin).length;

  if (totalWanted < personas.length) {
    warnings.push('Accounts ' + acct.account_key + ': user_count is ' + totalWanted +
      ' but ' + personas.length + ' named personas exist — using ' + personas.length + '.');
  }
  if (adminsWanted < personaAdmins) {
    warnings.push('Accounts ' + acct.account_key + ': admin_count is ' + adminsWanted +
      ' but ' + personaAdmins + ' named personas are admins — using ' + personaAdmins + '.');
  }

  const fillersNeeded = Math.max(0, totalWanted - personas.length);
  const adminFillersNeeded = Math.max(0, adminsWanted - personaAdmins);

  for (let i = 1; i <= fillersNeeded; i++) {
    const nn = (i < 10 ? '0' : '') + i;
    const naturalKey = 'user:filler:' + acct.account_key + ':' + nn;
    const isAdmin = i <= adminFillersNeeded;
    const identity = 'filler|' + acct.account_key + '|' + nn;
    const name = deterministicName(identity, seed);

    let email = emailByNaturalKey[naturalKey] || '';
    if (!email) {
      email = (name.first + '.' + name.last + '@' + domain).toLowerCase();
      let n = 2;
      while (taken[email]) {
        email = (name.first + '.' + name.last + n + '@' + domain).toLowerCase();
        n++;
      }
    }
    taken[email] = true;

    const titles = isAdmin ? ADMIN_TITLES : LEARNER_TITLES;
    users.push({
      natural_key: naturalKey,
      person_key: '',
      first_name: name.first,
      last_name: name.last,
      email: email,
      job_title: titles[jitter('title|' + identity, seed, titles.length)],
      is_admin: isAdmin,
      account_key: acct.account_key,
      use_case: acct.use_case,
      generated: true
    });
  }

  return users;
}

// ---------------------------------------------------------------------------
// Stats — so preview and validation can check the headline numbers
// ---------------------------------------------------------------------------

function accountStats_(accounts, plan) {
  const byKey = {};
  accounts.forEach(a => {
    byKey[a.account_key] = {
      account_key: a.account_key,
      company_name: a.company_name,
      cohort: a.cohort,
      use_case: String(a.use_case || '').trim(),
      users: 0, admins: 0,
      enrollments: 0, completed: 0, in_progress: 0, not_started: 0, overdue: 0,
      target: num_(a.required_complete_target, null),
      actual: null
    };
  });
  plan.learnupon.users.forEach(u => {
    const s = byKey[u.account_key];
    if (!s) return;
    s.users++;
    if (u.is_admin) s.admins++;
  });
  plan.learnupon.enrollments.forEach(e => {
    const s = byKey[e.account_key];
    if (!s) return;
    s.enrollments++;
    s[e.status]++;
    if (e.overdue) s.overdue++;
  });
  return Object.keys(byKey).map(k => {
    const s = byKey[k];
    s.actual = s.enrollments ? Math.round(100 * s.completed / s.enrollments) : null;
    return s;
  });
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function planSummary(plan) {
  const l = plan.learnupon;
  const lines = [
    'Scenario: ' + (plan.scope === 'all' || !plan.scope ? 'ALL SCENARIOS' : plan.scope),
    'Anchor T: ' + plan.anchor + '     seed: ' + plan.seed,
    'Environment: ' + plan.environment,
    '',
    'LearnUpon records to create',
    '  users .......... ' + l.users.length + '  (' + l.users.filter(u => u.generated).length +
      ' generated, ' + l.users.filter(u => !u.generated).length + ' named)',
    '  groups ......... ' + l.groups.length,
    '  memberships .... ' + l.memberships.length,
    '  courses ........ ' + l.courses.length,
    '  enrollments .... ' + l.enrollments.length +
      '  (' + l.enrollments.filter(e => e.status === 'completed').length + ' completed, ' +
      l.enrollments.filter(e => e.status === 'in_progress').length + ' in progress, ' +
      l.enrollments.filter(e => e.status === 'not_started').length + ' not started)',
    '  overdue ........ ' + l.enrollments.filter(e => e.overdue).length
  ];

  const h = plan.hubspot;
  if (h.companies.length || h.tickets.length || h.deals.length) {
    lines.push('', 'HubSpot records to create',
      '  companies ...... ' + h.companies.length,
      '  contacts ....... ' + h.contacts.length,
      '  tickets ........ ' + h.tickets.length,
      '  deals .......... ' + h.deals.length);
    const byCat = {};
    h.tickets.forEach(t => { byCat[t.category_label] = (byCat[t.category_label] || 0) + 1; });
    Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]).forEach(k => {
      lines.push('      ' + pad_(k, 32) + byCat[k]);
    });
  }

  lines.push('', 'Per account — required training complete');
  plan.stats.byAccount.forEach(s => {
    if (!s.enrollments) return;
    const drift = (s.target !== null && s.actual !== null) ? Math.abs(s.target - s.actual) : 0;
    lines.push('  ' + pad_(s.account_key, 16) + pad_(s.actual + '%', 6) +
      (s.target === null ? '' : '(target ' + s.target + '%)' + (drift > 2 ? '  <-- DRIFT' : '')) +
      '   ' + s.overdue + ' overdue of ' + s.enrollments);
  });
  if (plan.manualTouches.length) {
    lines.push('', 'MANUAL STEP — ' + plan.manualTouches.length + ' in-progress enrollment(s)',
      '  The API cannot create an in-progress enrollment. These are seeded as not-started;',
      '  open each one in the portal UI to make it in-progress. Full list on _Preview.');
    plan.manualTouches.slice(0, 6).forEach(m =>
      lines.push('    ' + m.full_name + ' — ' + m.course_title + ' (' + m.percentage + '%)'));
    if (plan.manualTouches.length > 6) {
      lines.push('    ... and ' + (plan.manualTouches.length - 6) + ' more');
    }
  }
  if (plan.warnings.length) {
    lines.push('', 'Warnings from expansion (' + plan.warnings.length + ')');
    plan.warnings.slice(0, 12).forEach(w => lines.push('  - ' + w));
    if (plan.warnings.length > 12) lines.push('  ... and ' + (plan.warnings.length - 12) + ' more');
  }
  return lines.join('\n');
}

function pad_(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

function writePreview(plan) {
  const at = nowIso();
  const rows = [];
  const push = (type, useCase, acct, nk, detail) =>
    rows.push([at, 'learnupon', type, useCase || '', acct || '', nk, detail]);

  plan.learnupon.groups.forEach(g => push('group', g.use_case, g.account_key, g.natural_key, g.title));
  plan.learnupon.courses.forEach(c => push('course', c.use_case, '', c.natural_key,
    c.title + '   [ref ' + c.reference_code + ', module ' + c.source_module_id + ']'));
  plan.learnupon.users.forEach(u => push('user', u.use_case, u.account_key, u.natural_key,
    u.first_name + ' ' + u.last_name + ' <' + u.email + '>   ' + u.job_title +
    (u.is_admin ? '   [admin]' : '') + (u.generated ? '   [generated]' : '')));
  plan.learnupon.enrollments.forEach(e => {
    const bits = [e.course_title, e.status];
    if (e.due_date) bits.push('due ' + ymd(e.due_date));
    if (e.overdue) bits.push('OVERDUE');
    if (e.date_completed) bits.push('completed ' + ymd(e.date_completed));
    if (e.percentage !== null && e.status === 'in_progress') bits.push(e.percentage + '%');
    if (e.needs_manual_touch) bits.push('** MANUAL TOUCH REQUIRED **');
    if (e.date_last_accessed) bits.push('last seen ' + ymd(e.date_last_accessed));
    push('enrollment', e.use_case, e.account_key, e.natural_key, e.email + '   ' + bits.join('   '));
  });
  plan.learnupon.memberships.forEach(m => push('membership', m.use_case, m.account_key,
    m.natural_key, m.group_natural_key));

  replaceTabBody(TAB.PREVIEW, rows);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Menu action: Preview (dry run)
// ---------------------------------------------------------------------------

function previewSeedPlan() {
  const result = validateWorkbook({ silent: true });
  if (result.errors > 0) {
    uiAlert('Preview blocked',
      result.errors + ' validation error(s) must be fixed first.\n\n' +
      'See the _Validation tab. Seeding and preview both refuse to run while errors exist.');
    return;
  }

  const plan = scopedPlan();
  const count = writePreview(plan);
  logAction({
    run_id: 'preview', action: 'preview', phase: 'dry-run', platform: 'learnupon',
    object_type: 'plan', intended: count, succeeded: count, failed: 0,
    notes: plan.warnings.length + ' expansion warning(s)'
  });

  uiAlert('Preview — nothing was written to any platform',
    'SCENARIO: ' + scopeLabel() + '\n\n' +
    planSummary(plan) + '\n\n' + count + ' rows written to the _Preview tab.' +
    (result.warnings ? '\n' + result.warnings + ' validation warning(s) on _Validation.' : ''));
}
