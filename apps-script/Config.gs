/**
 * Config.gs — settings, credentials, sheet I/O, locking, logging.
 *
 * Credentials live in Script Properties, keyed per environment, and are never written to a cell,
 * a log or the manifest. Settings.environment selects which set is in play.
 */

const CRED_SPEC = {
  test: [
    ['LU_TEST_SUBDOMAIN', 'LearnUpon subdomain for the throwaway test portal (e.g. acmesandbox)'],
    ['LU_TEST_USERNAME', 'LearnUpon API key pair — username half'],
    ['LU_TEST_PASSWORD', 'LearnUpon API key pair — password half'],
    ['HS_TEST_TOKEN', 'HubSpot private app token (leave blank for now)']
  ],
  demo: [
    ['LU_DEMO_SUBDOMAIN', 'LearnUpon subdomain for the ACME demo portal'],
    ['LU_DEMO_USERNAME', 'LearnUpon API key pair — username half'],
    ['LU_DEMO_PASSWORD', 'LearnUpon API key pair — password half'],
    ['HS_DEMO_TOKEN', 'HubSpot private app token (leave blank for now)'],
    ['HS_DEMO_PORTAL_ID', 'HubSpot portal id (leave blank for now)']
  ]
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSettings() {
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.SETTINGS);
  if (!sh) throw new Error('No Settings tab. Run Setup -> Create / Repair Workbook first.');
  const last = sh.getLastRow();
  const out = {};
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, 2).getValues().forEach(r => {
    const k = String(r[0]).trim();
    if (!k) return;
    // Values are trimmed, because a stray space in prng_seed would silently change every date.
    // Prefixes are the exception: "Customer: " needs its trailing space.
    const isPrefix = k.slice(-7) === '_prefix';
    out[k] = (typeof r[1] === 'string' && !isPrefix) ? r[1].trim() : r[1];
  });
  return out;
}

function getSetting(key, fallback) {
  const v = getSettings()[key];
  return (v === undefined || v === '') ? fallback : v;
}

function currentEnvironment() {
  const e = String(getSetting('environment', 'test')).trim();
  if (ENUM.ENVIRONMENT.indexOf(e) === -1) {
    throw new Error('Settings.environment must be one of: ' + ENUM.ENVIRONMENT.join(', '));
  }
  return e;
}

/** Human-readable description of the portal we are pointed at — goes in every write dialog. */
function environmentLabel() {
  const e = currentEnvironment();
  const sub = PropertiesService.getScriptProperties().getProperty(
    e === 'test' ? 'LU_TEST_SUBDOMAIN' : 'LU_DEMO_SUBDOMAIN');
  return e.toUpperCase() + (sub ? ' (' + sub + '.learnupon.com)' : ' (subdomain not set)');
}

/**
 * The scenario you are currently working on.
 *
 * Three people share one workbook, one script project and one portal. Every write action, and every
 * destructive one, is filtered to this value — so Nik running Reset cannot delete Brian's
 * enrollments. Set it to "all" only when deliberately seeding everything at once.
 */
/**
 * Set for the duration of one menu action by the per-scenario menu wrappers, so "Seed uc2" acts on
 * uc2 whatever the Settings tab happens to say. Nothing is written to the sheet, so two people
 * working in different scenarios never fight over the setting.
 */
let SCOPE_OVERRIDE_ = null;

function withScope_(useCase, fn) {
  const previous = SCOPE_OVERRIDE_;
  SCOPE_OVERRIDE_ = useCase;
  try {
    return fn();
  } finally {
    SCOPE_OVERRIDE_ = previous;
  }
}

function activeUseCase() {
  if (SCOPE_OVERRIDE_) return SCOPE_OVERRIDE_;
  const uc = String(getSetting('active_use_case', 'uc1')).trim();
  if (ENUM.USE_CASE_SCOPE.indexOf(uc) === -1) {
    throw new Error('Settings.active_use_case must be one of: ' + ENUM.USE_CASE_SCOPE.join(', ') +
      '. It decides which scenario every action applies to.');
  }
  return uc;
}

function inScope_(useCase, scope) {
  return scope === 'all' || String(useCase).trim() === scope;
}

/** Scenario metadata for a use case, so dialogs can name the owner. */
function scenarioFor(useCase) {
  let rows = [];
  try { rows = tabRows(TAB.SCENARIOS); } catch (e) { return null; }
  return rows.filter(r => String(r.use_case).trim() === String(useCase).trim())[0] || null;
}

/** "uc2 — Knowledge Gaps vs Support Tickets (owned by Michael)" for confirmation dialogs. */
function scopeLabel() {
  const uc = activeUseCase();
  if (uc === 'all') return 'ALL SCENARIOS';
  const s = scenarioFor(uc);
  if (!s) return uc;
  return uc + ' — ' + (s.scenario_name || '') +
    (s.owner_name ? '  (owned by ' + s.owner_name + ')' : '');
}

// ---------------------------------------------------------------------------
// Sheet I/O
// ---------------------------------------------------------------------------

/**
 * Reads a tab as an array of objects keyed by header name, skipping fully blank rows.
 * Each object carries _row, the real sheet row number, so validation can point at it.
 */
function tabRows(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run Setup -> Create / Repair Workbook.');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const width = sh.getLastColumn();
  const values = sh.getRange(1, 1, last, width).getValues();
  const headers = values[0].map(h => String(h).trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    // `false` counts as blank. Applying checkbox validation to a column materialises FALSE into
    // every empty cell in the range, which would otherwise make 190-odd untouched rows look like
    // real records with a missing key. Every genuine row carries a key, so nothing is lost.
    if (raw.every(c => c === '' || c === null || c === false)) continue;
    const obj = { _row: i + 1 };
    headers.forEach((h, j) => {
      if (!h) return;
      obj[h] = typeof raw[j] === 'string' ? raw[j].trim() : raw[j];
    });
    rows.push(obj);
  }
  return rows;
}

/** Replaces a tab's body (everything below the header) with rows2d. */
function replaceTabBody(name, rows2d) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  const width = sh.getLastColumn();
  if (sh.getMaxRows() > 1) sh.getRange(2, 1, sh.getMaxRows() - 1, width).clearContent();
  if (!rows2d || !rows2d.length) return;
  const needed = rows2d.length + 1;
  if (sh.getMaxRows() < needed) sh.insertRowsAfter(sh.getMaxRows(), needed - sh.getMaxRows());
  sh.getRange(2, 1, rows2d.length, rows2d[0].length).setValues(rows2d);
}

function appendTabRows(name, rows2d) {
  if (!rows2d || !rows2d.length) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  const start = Math.max(sh.getLastRow() + 1, 2);
  const needed = start + rows2d.length - 1;
  if (sh.getMaxRows() < needed) sh.insertRowsAfter(sh.getMaxRows(), needed - sh.getMaxRows());
  sh.getRange(start, 1, rows2d.length, rows2d[0].length).setValues(rows2d);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function setCredentials() {
  const ui = SpreadsheetApp.getUi();
  const env = currentEnvironment();
  const props = PropertiesService.getScriptProperties();
  const spec = CRED_SPEC[env];

  const intro = ui.alert('Set credentials — ' + env.toUpperCase(),
    'You will be prompted for ' + spec.length + ' values for the "' + env + '" environment.\n\n' +
    'Leave a prompt blank to keep the existing value. Values are stored in Script Properties, ' +
    'never in this sheet.\n\nSwitch Settings.environment first if this is the wrong portal.',
    ui.ButtonSet.OK_CANCEL);
  if (intro !== ui.Button.OK) return;

  let saved = 0;
  for (let i = 0; i < spec.length; i++) {
    const [key, desc] = spec[i];
    const has = props.getProperty(key) ? ' [currently set]' : ' [not set]';
    const res = ui.prompt(key + has, desc + '\n\nLeave blank to keep the current value.',
      ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) break;
    const val = res.getResponseText().trim();
    if (val) { props.setProperty(key, val); saved++; }
  }
  ui.alert('Credentials', saved + ' value(s) updated for ' + env + '.\n\n' +
    'Now run Setup -> Check Credentials.', ui.ButtonSet.OK);
}

/** Returns the credentials for the current environment. Throws a clear error when incomplete. */
function getCreds() {
  const env = currentEnvironment();
  const p = PropertiesService.getScriptProperties();
  const pre = env === 'test' ? 'LU_TEST_' : 'LU_DEMO_';
  const creds = {
    environment: env,
    subdomain: p.getProperty(pre + 'SUBDOMAIN'),
    username: p.getProperty(pre + 'USERNAME'),
    password: p.getProperty(pre + 'PASSWORD'),
    hubspotToken: p.getProperty(env === 'test' ? 'HS_TEST_TOKEN' : 'HS_DEMO_TOKEN')
  };
  const missing = ['subdomain', 'username', 'password'].filter(k => !creds[k]);
  if (missing.length) {
    throw new Error('LearnUpon credentials incomplete for environment "' + env + '": missing ' +
      missing.join(', ') + '. Run Setup -> Set Credentials.');
  }
  return creds;
}

function learnUponBase(creds) {
  return 'https://' + creds.subdomain + '.learnupon.com/api/v1/';
}

function learnUponAuthHeader(creds) {
  return 'Basic ' + Utilities.base64Encode(creds.username + ':' + creds.password);
}

/** Verifies connectivity without printing any secret. */
function checkCredentials() {
  const ui = SpreadsheetApp.getUi();
  let creds;
  try {
    creds = getCreds();
  } catch (e) {
    ui.alert('Check Credentials', String(e.message), ui.ButtonSet.OK);
    return;
  }

  const url = learnUponBase(creds) + 'users?limit=1';
  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: learnUponAuthHeader(creds), Accept: 'application/json' },
      muteHttpExceptions: true
    });
  } catch (e) {
    ui.alert('Check Credentials', 'Environment: ' + creds.environment + '\nPortal: ' +
      creds.subdomain + '.learnupon.com\n\nRequest failed: ' + String(e.message), ui.ButtonSet.OK);
    return;
  }

  const code = res.getResponseCode();
  const headers = res.getAllHeaders();
  const remainingMinute = headers['X-LU-Rate-Limit-Remaining-Minute'] ||
    headers['x-lu-rate-limit-remaining-minute'] || 'n/a';
  const remainingWeek = headers['X-LU-Rate-Limit-Remaining-Week'] ||
    headers['x-lu-rate-limit-remaining-week'] || 'n/a';

  let detail;
  if (code === 200) {
    let count = 'unknown';
    try {
      const body = JSON.parse(res.getContentText());
      const users = body.users || body.data || [];
      count = Array.isArray(users) ? String(users.length) + ' returned' : 'parsed';
    } catch (e) {
      count = 'response was not JSON';
    }
    detail = 'OK — authenticated.\nUsers endpoint: ' + count;
  } else if (code === 401 || code === 403) {
    detail = 'FAILED — ' + code + '. The API key pair was rejected. Re-enter it with Set Credentials.';
  } else if (code === 404) {
    detail = 'FAILED — 404. The subdomain is probably wrong.';
  } else {
    detail = 'Unexpected HTTP ' + code + '.\n' + res.getContentText().slice(0, 300);
  }

  ui.alert('Check Credentials',
    'Environment: ' + creds.environment + '\n' +
    'Portal: ' + creds.subdomain + '.learnupon.com\n\n' + detail + '\n\n' +
    'Rate limit remaining — minute: ' + remainingMinute + ', week: ' + remainingWeek,
    ui.ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// Locking, run ids, logging
// ---------------------------------------------------------------------------

/**
 * Three people share this sheet, and two simultaneous seeds would corrupt the manifest.
 * Every write action goes through here.
 */
function withLock(fn) {
  const lock = LockService.getScriptLock();
  // 5 seconds was too short: a phase that takes a minute made the next one fail instead of queue,
  // and the resulting overlap corrupted the manifest. Wait long enough to actually serialise.
  if (!lock.tryLock(120000)) {
    throw new Error('Another seed phase is still running. Wait for it to finish and try again — ' +
      'overlapping phases corrupt the manifest.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function newRunId() {
  return Utilities.formatDate(new Date(), 'Etc/UTC', 'yyyyMMdd-HHmmss') + '-' +
    Utilities.getUuid().slice(0, 4);
}

function nowIso() {
  return Utilities.formatDate(new Date(), 'Etc/UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

/** Appends one row to _Log. o = {run_id, action, phase, platform, object_type, intended, succeeded, failed, notes} */
function logAction(o) {
  appendTabRows(TAB.LOG, [[
    nowIso(), o.run_id || '', o.action || '', o.phase || '', o.platform || '',
    o.object_type || '', o.intended === undefined ? '' : o.intended,
    o.succeeded === undefined ? '' : o.succeeded, o.failed === undefined ? '' : o.failed,
    o.notes || ''
  ]]);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function uiAlert(title, message) {
  try {
    SpreadsheetApp.getUi().alert(title, message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    Logger.log(title + '\n' + message); // running from the editor, no UI available
  }
}

/** Destructive actions require the user to type an exact word. */
function uiConfirmTyped(word, message) {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Confirm', message + '\n\nType ' + word + ' to proceed.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return false;
  return res.getResponseText().trim() === word;
}
