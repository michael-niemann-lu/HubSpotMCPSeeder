/**
 * Dates.gs — the offset grammar.
 *
 *   T, T+n, T-n     the global anchor (today, or Settings.t_anchor_date when pinned)
 *   S, S+n, S-n     that account's onboarding start date
 *   G, G+n, G-n     that account's target go-live date
 *
 * Any offset cell also accepts a range, "A..B", which is jittered per record. That is what makes
 * overdue counts emerge from the data instead of being declared: due_offset = G-40..G-5 gives every
 * enrollment its own due date inside that window.
 *
 * All arithmetic is UTC so it cannot drift with the script timezone.
 */

const MS_DAY = 86400000;
const OFFSET_RE = /^([TSG])(?:\s*([+-])\s*(\d+))?$/;

function todayUtc() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

function addDays(d, n) {
  return new Date(d.getTime() + n * MS_DAY);
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / MS_DAY);
}

function ymd(d) {
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

/** LearnUpon wants ISO 8601 UTC for timestamps; midday avoids any same-day boundary surprises. */
function isoAtMidday(d) {
  return ymd(d) + 'T12:00:00Z';
}

/** Sheet date cells come back as Date objects in the script timezone; strings must be ISO. */
function coerceDate(v) {
  if (v instanceof Date) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) throw new Error('Expected a date as YYYY-MM-DD, got "' + s + '"');
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function resolveAnchor(settings) {
  const mode = String(settings.t_anchor_mode || 'today').trim();
  if (mode === 'pinned') {
    if (!settings.t_anchor_date) {
      throw new Error('Settings.t_anchor_mode is "pinned" but t_anchor_date is empty.');
    }
    return coerceDate(settings.t_anchor_date);
  }
  return todayUtc();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseOffsetToken(tok) {
  const s = String(tok).trim().toUpperCase();
  const m = OFFSET_RE.exec(s);
  if (!m) {
    throw new Error('Bad offset "' + tok + '". Expected T, S or G, optionally followed by +n or -n ' +
      '(e.g. T-90, G-14, S+31).');
  }
  const days = m[2] ? (m[2] === '-' ? -1 : 1) * parseInt(m[3], 10) : 0;
  return { base: m[1], days: days };
}

/** Returns {from, to, raw} or null for a blank cell. A single token yields from === to. */
function parseOffsetSpec(v) {
  if (v === '' || v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const parts = s.split('..');
  if (parts.length > 2) {
    throw new Error('Bad offset range "' + s + '". Use one token, or two separated by "..".');
  }
  const from = parseOffsetToken(parts[0]);
  const to = parts.length === 2 ? parseOffsetToken(parts[1]) : from;
  return { from: from, to: to, raw: s };
}

/** "15..70" or "30" -> {min, max}. Used for in_progress_pct. */
function parseNumberSpec(v) {
  if (v === '' || v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const parts = s.split('..');
  const nums = parts.map(p => {
    const n = Number(String(p).trim());
    if (isNaN(n)) throw new Error('Bad number "' + s + '". Use 30 or a range like 15..70.');
    return n;
  });
  if (nums.length > 2) throw new Error('Bad number range "' + s + '".');
  return { min: Math.min(nums[0], nums[nums.length - 1]), max: Math.max(nums[0], nums[nums.length - 1]) };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function resolveToken(tok, ctx) {
  const base = ctx[tok.base];
  if (!base) {
    throw new Error('Offset "' + tok.base + (tok.days ? (tok.days > 0 ? '+' : '') + tok.days : '') +
      '" needs a ' + (tok.base === 'S' ? 'onboarding_start_offset' : 'target_go_live_offset') +
      ' on the account, which is blank.');
  }
  return addDays(base, tok.days);
}

/**
 * Resolves an offset spec to a single date. Ranges are jittered deterministically from the
 * record's own identity, so inserting an unrelated row changes nothing else.
 */
function resolveOffsetSpec(spec, ctx, identity, seed) {
  if (!spec) return null;
  const a = resolveToken(spec.from, ctx);
  const b = resolveToken(spec.to, ctx);
  const lo = a.getTime() <= b.getTime() ? a : b;
  const span = Math.abs(daysBetween(a, b));
  return span === 0 ? lo : addDays(lo, jitter(identity, seed, span + 1));
}

function resolveNumberSpec(spec, identity, seed) {
  if (!spec) return null;
  if (spec.min === spec.max) return spec.min;
  return spec.min + jitter(identity, seed, Math.round(spec.max - spec.min) + 1);
}

/**
 * Builds {T, S, G, A} for one account. S must be T-based because it defines the S base itself;
 * G may be T- or S-based, which is what lets established accounts say "went live on S+31".
 */
function accountDateContext(account, T) {
  const ctx = { T: T, S: null, G: null, A: null };

  const sSpec = parseOffsetSpec(account.onboarding_start_offset);
  if (sSpec) {
    if (sSpec.from.base !== 'T' || sSpec.to.base !== 'T') {
      throw new Error('Accounts.onboarding_start_offset must be T-based — it is what defines S.');
    }
    if (sSpec.from.days !== sSpec.to.days) {
      throw new Error('Accounts.onboarding_start_offset must be a single offset, not a range.');
    }
    ctx.S = resolveToken(sSpec.from, ctx);
  }

  const gSpec = parseOffsetSpec(account.target_go_live_offset);
  if (gSpec) {
    if (gSpec.from.days !== gSpec.to.days || gSpec.from.base !== gSpec.to.base) {
      throw new Error('Accounts.target_go_live_offset must be a single offset, not a range.');
    }
    ctx.G = resolveToken(gSpec.from, ctx);
  }

  const aSpec = parseOffsetSpec(account.actual_go_live_offset);
  if (aSpec) ctx.A = resolveToken(aSpec.from, ctx);

  return ctx;
}

// ---------------------------------------------------------------------------
// Menu action: Developer -> Show Resolved Dates
// ---------------------------------------------------------------------------

function showResolvedDates() {
  const settings = getSettings();
  const T = resolveAnchor(settings);
  const lines = ['Anchor T = ' + ymd(T) + '  (mode: ' + (settings.t_anchor_mode || 'today') + ')', ''];

  tabRows(TAB.ACCOUNTS).forEach(a => {
    try {
      const ctx = accountDateContext(a, T);
      lines.push(a.account_key + '  [' + (a.cohort || '?') + ']');
      lines.push('   S onboarding start : ' + (ctx.S ? ymd(ctx.S) : '—'));
      lines.push('   G target go-live   : ' + (ctx.G ? ymd(ctx.G) : '—') +
        (ctx.G ? '   (' + daysBetween(T, ctx.G) + ' days from T)' : ''));
      lines.push('   A actual go-live   : ' + (ctx.A ? ymd(ctx.A) : '—') +
        (ctx.S && ctx.A ? '   (day ' + daysBetween(ctx.S, ctx.A) + ' of onboarding)' : ''));
    } catch (e) {
      lines.push(a.account_key + '  ERROR: ' + e.message);
    }
    lines.push('');
  });

  uiAlert('Resolved dates', lines.join('\n'));
}
