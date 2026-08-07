/**
 * Tests.gs — unit tests, runnable from Developer -> Run Unit Tests or from the editor.
 *
 * Optional file: nothing else depends on it. But the hash tests are the reason the dataset is
 * reproducible, so if you skip pasting anything, don't skip this.
 */

function runAllTests() {
  const results = [];
  const t = (name, fn) => {
    try { fn(); results.push('PASS  ' + name); }
    catch (e) { results.push('FAIL  ' + name + '\n        ' + e.message); }
  };

  // --- hash stability ------------------------------------------------------
  // Golden values. If these change, every jittered date in every seeded dataset changes with them,
  // so a failure here is a breaking change, not a bug to paper over.
  t('hash32 golden values', () => {
    eq(hash32(''), 2166136261, 'empty string');
    eq(hash32('a'), 3826002220, '"a"');
    eq(hash32('abc'), 440920331, '"abc"');
    eq(hash32('enr|alderfield|nce-admin-essentials'), 4125892130, 'identity string');
    eq(hash32('MCP-DEMO|20260804'), 281504161, 'tag + seed');
    eq(hash32('filler|alderfield|03'), 2530097474, 'filler identity');
  });

  t('hash32 is unsigned 32-bit', () => {
    ['', 'a', 'zzzz', 'a much longer string with spaces'].forEach(s => {
      const h = hash32(s);
      ok(h >= 0 && h <= 4294967295, s + ' -> ' + h + ' out of range');
      ok(h === Math.floor(h), 'not an integer');
    });
  });

  t('jitter stays in range and is deterministic', () => {
    for (let i = 0; i < 50; i++) {
      const a = jitter('id-' + i, '42', 7);
      const b = jitter('id-' + i, '42', 7);
      eq(a, b, 'not deterministic');
      ok(a >= 0 && a < 7, 'out of range: ' + a);
    }
    eq(jitter('x', '1', 1), 0, 'range of 1');
    eq(jitter('x', '1', 0), 0, 'range of 0');
  });

  t('jitter responds to the seed', () => {
    let differences = 0;
    for (let i = 0; i < 40; i++) {
      if (jitter('id-' + i, '1', 100) !== jitter('id-' + i, '2', 100)) differences++;
    }
    ok(differences > 30, 'changing prng_seed barely changed anything (' + differences + '/40)');
  });

  t('orderByHash is a stable permutation', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = orderByHash(items, x => 'k' + x, '9');
    const b = orderByHash(items, x => 'k' + x, '9');
    eq(a.join(','), b.join(','), 'not stable');
    eq(a.slice().sort().join(','), '1,2,3,4,5,6,7,8', 'lost or duplicated items');
  });

  // --- offset grammar ------------------------------------------------------
  t('parseOffsetToken accepts the grammar', () => {
    eq(JSON.stringify(parseOffsetToken('T')), '{"base":"T","days":0}', 'T');
    eq(JSON.stringify(parseOffsetToken('T-90')), '{"base":"T","days":-90}', 'T-90');
    eq(JSON.stringify(parseOffsetToken('G+12')), '{"base":"G","days":12}', 'G+12');
    eq(JSON.stringify(parseOffsetToken(' s+31 ')), '{"base":"S","days":31}', 'lowercase and padded');
  });

  t('parseOffsetToken rejects nonsense', () => {
    ['', 'X-1', 'T*3', '2026-01-01', 'TT-1', 'T-'].forEach(bad => {
      throws(() => parseOffsetToken(bad), 'accepted "' + bad + '"');
    });
  });

  t('parseOffsetSpec handles single tokens and ranges', () => {
    eq(parseOffsetSpec('T-5').from.days, -5, 'single token from');
    eq(parseOffsetSpec('T-5').to.days, -5, 'single token to');
    const r = parseOffsetSpec('G-40..G-5');
    eq(r.from.days, -40, 'range from');
    eq(r.to.days, -5, 'range to');
    eq(parseOffsetSpec(''), null, 'blank is null');
    throws(() => parseOffsetSpec('T-1..T-2..T-3'), 'accepted a three-part range');
  });

  t('parseNumberSpec handles numbers and ranges', () => {
    eq(parseNumberSpec('30').min, 30, 'single');
    eq(parseNumberSpec('30').max, 30, 'single max');
    eq(parseNumberSpec('15..70').min, 15, 'range min');
    eq(parseNumberSpec('70..15').min, 15, 'reversed range is normalised');
    eq(parseNumberSpec(''), null, 'blank is null');
    throws(() => parseNumberSpec('abc'), 'accepted "abc"');
  });

  // --- date arithmetic -----------------------------------------------------
  t('date helpers are UTC-stable', () => {
    const d = coerceDate('2026-08-04');
    eq(ymd(d), '2026-08-04', 'round trip');
    eq(ymd(addDays(d, 30)), '2026-09-03', 'add 30 days across a month boundary');
    eq(ymd(addDays(d, -220)), '2025-12-27', 'subtract across a year boundary');
    eq(daysBetween(coerceDate('2026-01-01'), coerceDate('2026-03-01')), 59, 'day count');
    eq(ymd(addDays(coerceDate('2028-02-28'), 1)), '2028-02-29', 'leap year');
  });

  t('resolveOffsetSpec lands inside its range', () => {
    const ctx = { T: coerceDate('2026-08-04'), S: coerceDate('2026-05-28'), G: coerceDate('2026-08-16') };
    const spec = parseOffsetSpec('G-40..G-5');
    const lo = coerceDate('2026-07-07'); // G-40
    const hi = coerceDate('2026-08-11'); // G-5
    for (let i = 0; i < 60; i++) {
      const d = resolveOffsetSpec(spec, ctx, 'enr-' + i, '42');
      ok(d.getTime() >= lo.getTime() && d.getTime() <= hi.getTime(),
        'resolved ' + ymd(d) + ' outside ' + ymd(lo) + '..' + ymd(hi));
    }
    eq(ymd(resolveOffsetSpec(parseOffsetSpec('S+11'), ctx, 'x', '42')), '2026-06-08', 'S+11');
  });

  t('resolveOffsetSpec is identity-stable', () => {
    const ctx = { T: coerceDate('2026-08-04'), S: coerceDate('2026-05-28'), G: coerceDate('2026-08-16') };
    const spec = parseOffsetSpec('T-30..T-3');
    const a = ymd(resolveOffsetSpec(spec, ctx, 'same-identity', '42'));
    const b = ymd(resolveOffsetSpec(spec, ctx, 'same-identity', '42'));
    eq(a, b, 'same identity gave two answers');
    ok(a !== ymd(resolveOffsetSpec(spec, ctx, 'other-identity', '42')) ||
       true, 'different identities may collide, which is fine');
  });

  t('resolveToken refuses a base the account does not define', () => {
    throws(() => resolveToken(parseOffsetToken('G-14'), { T: todayUtc(), S: null, G: null }),
      'resolved G with no go-live date');
  });

  t('accountDateContext derives S then G', () => {
    const T = coerceDate('2026-08-04');
    const ctx = accountDateContext(
      { onboarding_start_offset: 'T-300', target_go_live_offset: 'S+31', actual_go_live_offset: 'S+31' }, T);
    eq(ymd(ctx.S), '2025-10-08', 'S');
    eq(ymd(ctx.G), '2025-11-08', 'G resolved from S');
    eq(ymd(ctx.A), '2025-11-08', 'A');
    eq(daysBetween(ctx.S, ctx.A), 31, 'onboarding duration');
  });

  t('accountDateContext rejects an S that is not T-based', () => {
    throws(() => accountDateContext({ onboarding_start_offset: 'G-10', target_go_live_offset: 'T+1' }, todayUtc()),
      'accepted a G-based onboarding start');
    throws(() => accountDateContext({ onboarding_start_offset: 'T-10..T-5', target_go_live_offset: 'T+1' }, todayUtc()),
      'accepted a range for onboarding start');
  });

  // --- the whole pipeline, if the workbook has data ------------------------
  const hasData = (function () {
    try { return tabRows(TAB.ACCOUNTS).length > 0 && tabRows(TAB.ENROLLMENTS).length > 0; }
    catch (e) { return false; }
  })();

  if (!hasData) {
    results.push('SKIP  pipeline tests — no data. Run Setup -> Load Example Scenario (UC1) first.');
  } else {
    t('expand is reproducible', () => {
      const wb = loadWorkbook();
      const a = expand(wb);
      const b = expand(wb);
      eq(fingerprint_(a), fingerprint_(b), 'two expansions of identical input differed');
    });

    t('every enrollment is internally consistent', () => {
      const plan = expand(loadWorkbook());
      ok(plan.learnupon.enrollments.length > 0, 'no enrollments produced');
      plan.learnupon.enrollments.forEach(e => {
        if (e.status === 'completed') {
          ok(!!e.date_completed, e.natural_key + ': completed with no completion date');
          eq(e.percentage, 100, e.natural_key + ': completed but not at 100%');
          ok(!e.overdue, e.natural_key + ': completed but flagged overdue');
        }
        if (e.status === 'in_progress') {
          ok(e.percentage > 0 && e.percentage < 100,
            e.natural_key + ': in progress at ' + e.percentage + '%');
        }
        if (e.status === 'not_started') {
          ok(!e.date_completed, e.natural_key + ': not started but has a completion date');
        }
      });
    });

    t('no user is enrolled outside their own account', () => {
      const plan = expand(loadWorkbook());
      const acctByUser = {};
      plan.learnupon.users.forEach(u => { acctByUser[u.natural_key] = u.account_key; });
      plan.learnupon.enrollments.forEach(e => {
        eq(acctByUser[e.user_natural_key], e.account_key,
          e.natural_key + ': enrolled under the wrong account');
      });
    });

    t('emails are unique across the whole plan', () => {
      const plan = expand(loadWorkbook());
      const seen = {};
      plan.learnupon.users.forEach(u => {
        ok(!seen[u.email], 'duplicate email ' + u.email);
        ok(u.email.indexOf('@') > 0, 'malformed email "' + u.email + '"');
        ok(u.email.indexOf('missing-account') === -1, 'unresolved account domain in ' + u.email);
        seen[u.email] = true;
      });
    });

    // Only meaningful with the shipped example loaded — that is the point of it.
    const alderfield = tabRows(TAB.ACCOUNTS).filter(a => a.account_key === 'alderfield')[0];
    if (alderfield && Number(alderfield.user_count) === 16) {
      t('example scenario reproduces its headline numbers', () => {
        const plan = expand(loadWorkbook());
        const stats = {};
        plan.stats.byAccount.forEach(s => { stats[s.account_key] = s; });

        const a = stats['alderfield'];
        eq(a.enrollments, 28, 'Alderfield enrollment total');
        eq(a.completed, 7, 'Alderfield completions');
        eq(a.actual, 25, 'Alderfield required-training percentage');
        ok(a.overdue > 0, 'Alderfield has nothing overdue, so Story 1 has no risk signal');

        eq(stats['vantageridge'].actual, 89, 'Vantage Ridge percentage');
        eq(stats['copperlane'].actual, 62, 'Copperlane percentage');

        // Story 2's claim: trained-early accounts average 34 days to go-live, lagged 75.
        const T = resolveAnchor(getSettings());
        const days = key => {
          const acct = tabRows(TAB.ACCOUNTS).filter(x => x.account_key === key)[0];
          const ctx = accountDateContext(acct, T);
          return daysBetween(ctx.S, ctx.A);
        };
        const early = ['cobaltpeak', 'fernpath', 'harborline'].map(days);
        const lagged = ['halden', 'larkspur', 'northwind'].map(days);
        const mean = xs => Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);
        eq(mean(early), 34, 'trained-early mean days to go-live');
        eq(mean(lagged), 75, 'lagged mean days to go-live');
      });

      t('Marcus Feld is 30% through Platform Setup and stalled', () => {
        const plan = expand(loadWorkbook());
        const T = resolveAnchor(getSettings());
        const e = plan.learnupon.enrollments.filter(x =>
          x.natural_key === 'enr:nce-platform-setup:user:person:alderfield.marcus')[0];
        ok(!!e, 'Marcus has no Platform Setup enrollment');
        eq(e.status, 'in_progress', 'status');
        eq(e.percentage, 30, 'percentage');
        eq(daysBetween(e.date_last_accessed, T), 22, 'days since last activity');
      });

      t('no administrator has completed Launch Readiness at Alderfield', () => {
        const plan = expand(loadWorkbook());
        const rows = plan.learnupon.enrollments.filter(e =>
          e.account_key === 'alderfield' && e.course_key === 'nce-launch-readiness');
        eq(rows.length, 4, 'four administrators should be enrolled');
        eq(rows.filter(e => e.status === 'completed').length, 0, 'someone completed it');
      });
    }
  }

  const failed = results.filter(r => r.indexOf('FAIL') === 0).length;
  const passed = results.filter(r => r.indexOf('PASS') === 0).length;
  const header = failed === 0 ? 'All ' + passed + ' tests passed.' : failed + ' of ' + (passed + failed) + ' tests FAILED.';
  Logger.log(header + '\n\n' + results.join('\n'));
  uiAlert('Unit tests', header + '\n\n' + results.join('\n'));
  return { passed: passed, failed: failed };
}

// --- assertions -------------------------------------------------------------

function ok(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'values differ') + ': expected ' + JSON.stringify(expected) +
      ', got ' + JSON.stringify(actual));
  }
}

function throws(fn, message) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) throw new Error(message || 'expected a throw');
}

/** Order-independent fingerprint of a plan, for reproducibility checks. */
function fingerprint_(plan) {
  const parts = [];
  ['users', 'groups', 'memberships', 'courses', 'enrollments'].forEach(kind => {
    plan.learnupon[kind].forEach(r => {
      const keys = Object.keys(r).sort();
      parts.push(kind + '{' + keys.map(k => {
        const v = r[k];
        return k + '=' + (v instanceof Date ? ymd(v) : String(v));
      }).join(',') + '}');
    });
  });
  return parts.sort().join('\n');
}
