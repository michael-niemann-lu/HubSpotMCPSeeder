/**
 * LearnUpon.gs — the HTTP client, plus the read-only setup checks.
 *
 * Nothing in this file writes to the portal. Every function here is a GET. The write paths are
 * added once the spikes are done, and they will go through luRequest_ so they inherit the pacing,
 * the retry policy and the call cap for free.
 *
 * Three protections are built into luRequest_ and none of them are optional:
 *   - pacing to ~4.5 req/sec, because LearnUpon's limit is ~5
 *   - a hard per-execution call cap, so a retry bug cannot burn a week of quota
 *   - a weekly-remaining floor, so we stop before we strand the demo portal
 */

const LU_MAX_CALLS_PER_RUN = 800;
const LU_MIN_INTERVAL_MS = 220;      // ~4.5 requests/second
const LU_WEEKLY_FLOOR = 250;         // refuse to keep going below this many weekly calls remaining
const LU_MAX_ATTEMPTS = 3;

const LU_FIELD_TYPES = {
  1: 'String (free text)',
  2: 'Decimal',
  3: 'Integer',
  4: 'String choice (dropdown)',
  5: 'Decimal choice',
  6: 'Integer choice',
  7: 'Date'
};

let LU_CALLS_MADE = 0;
let LU_LAST_CALL_AT = 0;
let LU_RATE = { minute: null, week: null };

function luResetCounters() {
  LU_CALLS_MADE = 0;
  LU_LAST_CALL_AT = 0;
  LU_RATE = { minute: null, week: null };
}

/**
 * The single choke point for every LearnUpon call.
 * opts: { allow404: true } to treat 404 as a normal result rather than an error.
 */
function luRequest_(method, path, payload, opts) {
  opts = opts || {};
  const creds = getCreds();

  if (LU_CALLS_MADE >= LU_MAX_CALLS_PER_RUN) {
    throw new Error('Call cap reached (' + LU_MAX_CALLS_PER_RUN + ' in one execution). This is a ' +
      'deliberate stop, not a LearnUpon limit — re-run the phase to continue.');
  }
  if (LU_RATE.week !== null && LU_RATE.week < LU_WEEKLY_FLOOR) {
    throw new Error('Stopping: only ' + LU_RATE.week + ' LearnUpon calls remain this week, below ' +
      'the ' + LU_WEEKLY_FLOOR + ' floor. Running the portal dry would break the demo, not just this run.');
  }

  const url = learnUponBase(creds) + path;
  const params = {
    method: method,
    headers: { Authorization: learnUponAuthHeader(creds), Accept: 'application/json' },
    muteHttpExceptions: true
  };
  // Only declare a JSON body when there is one. Sending Content-Type: application/json on a bodyless
  // GET makes LearnUpon try to parse the empty body and reject it with
  // 400 "There was a problem in the JSON you submitted."
  if (payload) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(payload);
  }

  let res = null, code = 0, lastError = '';
  for (let attempt = 1; attempt <= LU_MAX_ATTEMPTS; attempt++) {
    const since = Date.now() - LU_LAST_CALL_AT;
    if (LU_LAST_CALL_AT && since < LU_MIN_INTERVAL_MS) Utilities.sleep(LU_MIN_INTERVAL_MS - since);

    try {
      res = UrlFetchApp.fetch(url, params);
    } catch (e) {
      lastError = String(e.message);
      Utilities.sleep(1000 * attempt);
      continue;
    } finally {
      LU_CALLS_MADE++;
      LU_LAST_CALL_AT = Date.now();
    }

    const headers = res.getAllHeaders();
    const readHeader = name => {
      const keys = Object.keys(headers);
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].toLowerCase() === name) {
          const v = Number(headers[keys[i]]);
          return isNaN(v) ? null : v;
        }
      }
      return null;
    };
    const m = readHeader('x-lu-rate-limit-remaining-minute');
    const w = readHeader('x-lu-rate-limit-remaining-week');
    if (m !== null) LU_RATE.minute = m;
    if (w !== null) LU_RATE.week = w;

    code = res.getResponseCode();
    if (code === 429) { Utilities.sleep(3000 * attempt); continue; }
    if (code >= 500) { Utilities.sleep(1500 * attempt); continue; }
    break;
  }

  if (!res) throw new Error(method.toUpperCase() + ' ' + path + ' failed: ' + lastError);

  const text = res.getContentText();
  if (code === 404 && opts.allow404) return { code: code, body: null, raw: text };
  if (code >= 400 && opts.raw) return { code: code, body: null, raw: text };
  if (code >= 400) {
    throw new Error(method.toUpperCase() + ' ' + path + ' returned HTTP ' + code + '. ' +
      String(text).slice(0, 400));
  }

  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
  return { code: code, body: body, raw: text };
}

function luGet_(path, opts) {
  return luRequest_('get', path, null, opts);
}

/**
 * LearnUpon wraps collections under different keys depending on the endpoint, so rather than
 * hardcode a guess, take the first array of objects we find.
 *
 * `prefer` matters more than it looks: GET /users/{id} returns customDataFieldDefintions BEFORE
 * the user array, so "first array in the body" silently returns field definitions instead of the
 * user. Always name the key you actually want when you know it.
 */
function firstArrayIn_(body, prefer) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  const keys = Object.keys(body);
  if (prefer) {
    for (let p = 0; p < prefer.length; p++) {
      const v = body[prefer[p]];
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object') return [v];
    }
  }
  for (let i = 0; i < keys.length; i++) {
    const v = body[keys[i]];
    if (Array.isArray(v)) return v;
  }
  for (let i = 0; i < keys.length; i++) {
    const v = body[keys[i]];
    if (v && typeof v === 'object') {
      const nested = firstArrayIn_(v);
      if (nested.length) return nested;
    }
  }
  return [];
}

function pick_(obj, names) {
  for (let i = 0; i < names.length; i++) {
    if (obj[names[i]] !== undefined && obj[names[i]] !== null) return obj[names[i]];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Setup -> Check Custom Fields
// ---------------------------------------------------------------------------

function checkCustomFields() {
  luResetCounters();
  const settings = getSettings();
  const wanted = [
    ['job_title_field_label', String(settings.job_title_field_label || '').trim(),
      'Story 3 identifies administrators by job title. Without this field, "which of these people are administrators?" has no answer.'],
    ['demo_source_field_label', String(settings.demo_source_field_label || '').trim(),
      'Tags our users so a human can recognise them in the portal UI.']
  ];

  let defs;
  try {
    defs = firstArrayIn_(luGet_('users/customuserdata').body);
  } catch (e) {
    uiAlert('Check Custom Fields', 'Could not read custom field definitions from ' +
      environmentLabel() + '.\n\n' + e.message);
    return;
  }

  const normalised = defs.map(d => ({
    id: pick_(d, ['id', 'definition_id']),
    label: String(pick_(d, ['label', 'field_label', 'name', 'title']) || ''),
    typeId: Number(pick_(d, ['type_id', 'field_type', 'type']))
  })).filter(d => d.label);

  const lines = ['Portal: ' + environmentLabel(), '',
    normalised.length + ' custom user data field(s) defined:', ''];
  normalised.forEach(d => {
    lines.push('  ' + (d.label + '                              ').slice(0, 30) +
      (LU_FIELD_TYPES[d.typeId] || 'type ' + d.typeId) + '   [id ' + d.id + ']');
  });

  lines.push('', '-'.repeat(60), '');
  let problems = 0;
  wanted.forEach(([key, label, why]) => {
    if (!label) {
      problems++;
      lines.push('MISSING   Settings.' + key + ' is blank.');
      lines.push('          ' + why);
      lines.push('');
      return;
    }
    const match = normalised.filter(d => d.label.toLowerCase() === label.toLowerCase())[0];
    if (!match) {
      problems++;
      lines.push('NOT FOUND "' + label + '"   (from Settings.' + key + ')');
      lines.push('          ' + why);
      lines.push('          Create it in the portal: Settings > Users > Custom User Data.');
    } else if (match.typeId !== 1) {
      problems++;
      lines.push('WRONG TYPE "' + match.label + '" is ' + (LU_FIELD_TYPES[match.typeId] || match.typeId) + '.');
      lines.push('          It must be String (free text), or we can only write values that already');
      lines.push('          exist in its dropdown, and every job title would have to be pre-created.');
    } else {
      lines.push('OK        "' + match.label + '"   String (free text), id ' + match.id);
      if (match.label !== label) {
        lines.push('          Note: portal label is "' + match.label + '", sheet says "' + label +
          '". Case-insensitive matching means this works, but tidy it up.');
      }
    }
    lines.push('');
  });

  if (normalised.length >= 10) {
    lines.push('Note: ' + normalised.length + ' fields defined. Portals get 10 by default — if you ' +
      'cannot add another, that limit is why, and a CSM can raise it.');
  }

  lines.push('', problems === 0
    ? 'Both fields are ready. Nothing was written to the portal.'
    : problems + ' problem(s) to fix before seeding users.');

  uiAlert('Check Custom Fields', lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Setup -> Check Course Source
// ---------------------------------------------------------------------------

/**
 * We build courses rather than cloning them, so what matters is the MODULE we attach.
 * Spike 4 established that component_type decides whether the finished course can be enrolled on
 * at all — an "ilt session" module makes every enrollment fail with "course capacity reached",
 * and a course with no modules fails too. Catching that here costs one call; catching it during a
 * 700-call seed costs the seed.
 */
const ENROLLABLE_TYPES = ['scorm', 'page', 'e signature', 'text', 'video'];
const BLOCKED_TYPES = {
  'ilt session': 'live sessions carry their own seat capacity — every enrollment fails with "course capacity reached"',
  'assignment': 'enrollment fails with "internal error" on the test portal',
  'exam': 'enrollment fails with "internal error" on the test portal'
};

function checkCourseSource() {
  luResetCounters();
  const settings = getSettings();
  const courses = tabRows(TAB.COURSES);

  const wanted = {};
  courses.forEach(c => {
    const id = String(c.source_module_id || '').trim();
    if (id) (wanted[id] = wanted[id] || []).push(c.course_key);
  });

  const lines = ['Portal: ' + environmentLabel(), ''];
  let problems = 0;

  const ownerId = String(settings.course_owner_id || '').trim();
  if (!ownerId) {
    problems++;
    lines.push('MISSING    Settings.course_owner_id is blank.');
    lines.push('           POST /courses requires an owner_id — a portal admin user id in THIS portal.');
    lines.push('');
  } else {
    // GET /users/{id} works, unlike GET /courses/{id}. And there is no user_id search param —
    // passing one is silently ignored and returns the whole roster.
    let found = null, lookupFailed = false;
    try {
      const body = luGet_('users/' + encodeURIComponent(ownerId), { allow404: true }).body;
      found = firstArrayIn_(body, ['user', 'users'])
        .filter(u => String(pick_(u, ['id'])) === String(ownerId))[0];
    } catch (e) { lookupFailed = true; }

    if (found) {
      lines.push('OK         course_owner_id ' + ownerId + '  (' +
        [found.first_name, found.last_name].join(' ').trim() + ', ' + (found.email || '') + ')');
    } else {
      problems++;
      lines.push('NOT FOUND  course_owner_id ' + ownerId +
        (lookupFailed ? '  — the lookup itself failed' : '  — no such user in this portal'));
      lines.push('           POST /courses will fail without a valid owner in THIS portal.');
      lines.push('           Settings.environment is "' + currentEnvironment() + '".');
    }
    lines.push('');
  }

  if (!Object.keys(wanted).length) {
    lines.push('No source_module_id set on the Courses tab.');
    uiAlert('Check Course Source', lines.join('\n'));
    return;
  }

  let modules = [];
  try {
    modules = firstArrayIn_(luGet_('modules').body);
  } catch (e) {
    uiAlert('Check Course Source', lines.join('\n') + '\nCould not list modules: ' + e.message);
    return;
  }

  const byId = {};
  modules.forEach(m => { byId[String(pick_(m, ['id']))] = m; });

  Object.keys(wanted).forEach(id => {
    const m = byId[id];
    if (!m) {
      problems++;
      lines.push('NOT FOUND  module ' + id + '   wanted by: ' + wanted[id].join(', '));
      lines.push('           No module with that id in this portal. Settings.environment is "' +
        currentEnvironment() + '".');
      lines.push('');
      return;
    }
    const type = String(pick_(m, ['component_type', 'type']) || '').toLowerCase();
    const name = pick_(m, ['name', 'title']) || '(unnamed)';
    const blocked = BLOCKED_TYPES[type];

    if (blocked) {
      problems++;
      lines.push('UNUSABLE   module ' + id + '   "' + name + '"');
      lines.push('           component_type "' + type + '" — ' + blocked + '.');
      lines.push('           Pick a SCORM module instead. Wanted by: ' + wanted[id].join(', '));
    } else if (ENROLLABLE_TYPES.indexOf(type) === -1) {
      lines.push('UNKNOWN    module ' + id + '   "' + name + '"   component_type "' + type + '"');
      lines.push('           Not a type we have tested. Seed one course first and confirm you can');
      lines.push('           enroll on it before running the full seed.');
    } else {
      lines.push('OK         module ' + id + '   "' + name + '"   ' + type);
      lines.push('           Used by ' + wanted[id].length + ' course(s): ' + wanted[id].join(', '));
    }
    lines.push('');
  });

  lines.push(problems === 0
    ? 'Course sources look good. Nothing was written to the portal.'
    : problems + ' problem(s). Fix before seeding courses.');
  lines.push('', 'Rate limit remaining — minute: ' + (LU_RATE.minute === null ? 'n/a' : LU_RATE.minute) +
    ', week: ' + (LU_RATE.week === null ? 'n/a' : LU_RATE.week) +
    '   (LearnUpon sends these on success only)');

  uiAlert('Check Course Source', lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Setup -> Find a Module
// ---------------------------------------------------------------------------

/**
 * Lists a course's modules with their component_type, so you can pick a source module for a new
 * portal without guessing. The type is the whole point: an "ilt session" module makes every
 * enrollment on the finished course fail with "course capacity reached".
 */
function findModule() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Find a module',
    'Enter a LearnUpon course id in ' + environmentLabel() + ' to list its modules.\n\n' +
    'Pick a SCORM one and put its id in the Courses tab, column source_module_id.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const courseId = res.getResponseText().trim();
  if (!courseId) return;

  luResetCounters();
  let modules;
  try {
    modules = firstArrayIn_(luGet_('modules?course_id=' + encodeURIComponent(courseId)).body, ['modules']);
  } catch (e) {
    uiAlert('Find a module', 'Could not list modules for course ' + courseId + '.\n\n' + e.message);
    return;
  }

  if (!modules.length) {
    uiAlert('Find a module', 'Course ' + courseId + ' has no modules, or the id is wrong.');
    return;
  }

  const seen = {};
  const lines = ['Portal: ' + environmentLabel(), '', 'Course ' + courseId + ' modules:', ''];
  modules.forEach(m => {
    const id = String(pick_(m, ['id']));
    if (seen[id]) return;   // ILT modules repeat the same id across sessions
    seen[id] = true;
    const type = String(pick_(m, ['component_type', 'type']) || '?').toLowerCase();
    const blocked = BLOCKED_TYPES[type];
    lines.push((blocked ? 'AVOID  ' : ENROLLABLE_TYPES.indexOf(type) !== -1 ? 'USE    ' : 'UNTESTED ') +
      id + '   ' + (type + '            ').slice(0, 14) + (pick_(m, ['name', 'title']) || ''));
    if (blocked) lines.push('         ' + blocked);
  });
  lines.push('', 'Put a USE id into Courses -> source_module_id, then run Check Course Source.');
  uiAlert('Find a module', lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Developer -> API Probe
// ---------------------------------------------------------------------------

/**
 * Read-only escape hatch. GET any path and see the raw response, without editing code.
 * Deliberately GET-only: this is a diagnostic, not a back door for writes.
 */
function apiProbe() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('API Probe — GET only',
    'Path after /api/v1/  — for example:\n\n' +
    '    courses/5128555\n' +
    '    users/customuserdata\n' +
    '    users?limit=1\n' +
    '    enrollments?user_id=123\n\n' +
    'Portal: ' + environmentLabel(), ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const path = res.getResponseText().trim().replace(/^\/+/, '');
  if (!path) return;

  luResetCounters();
  let r;
  try {
    r = luRequest_('get', path, null, { raw: true, allow404: true });
  } catch (e) {
    uiAlert('API Probe', 'GET ' + path + '\n\nRequest failed: ' + e.message);
    return;
  }

  let pretty = r.raw || '(empty response)';
  try { pretty = JSON.stringify(JSON.parse(r.raw), null, 2); } catch (e) { /* leave as-is */ }
  if (pretty.length > 2000) pretty = pretty.slice(0, 2000) + '\n... truncated';

  uiAlert('API Probe',
    'GET ' + path + '\nHTTP ' + r.code + '\n' +
    'Rate limit remaining — minute: ' + (LU_RATE.minute === null ? 'not sent' : LU_RATE.minute) +
    ', week: ' + (LU_RATE.week === null ? 'not sent' : LU_RATE.week) + '\n\n' + pretty);
}
