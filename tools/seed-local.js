#!/usr/bin/env node
/**
 * seed-local.js — runs the REAL Seed/Reset/Verify code against the throwaway portal, with the
 * spreadsheet faked in memory.
 *
 * This is how we test the seeder without pasting into the editor and clicking. It loads the actual
 * .gs files and provides Apps Script's globals: UrlFetchApp is shelled through curl (Apps Script's
 * fetch is synchronous and Node's is not), the UI auto-confirms, and the manifest lives in a JS
 * array instead of a tab.
 *
 * It deliberately runs a TINY subset — one account, three users, one course — because completions
 * are permanent and this writes to a real portal.
 *
 *   node tools/seed-local.js            seed -> verify -> reset -> verify
 *   node tools/seed-local.js teardown   remove the courses and groups it created
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'apps-script');
const FILES = ['Schema.gs', 'Random.gs', 'Dates.gs', 'Expand.gs', 'Validate.gs', 'Scenario1.gs',
  'Manifest.gs', 'LearnUpon.gs', 'Seed.gs', 'Reset.gs', 'Refresh.gs',
  'HubSpot.gs', 'HubSpotSeed.gs', 'HubSpotRefresh.gs'];
const ENV_PATH = path.join(SRC, 'local', '.env');
const STATE_PATH = path.join(SRC, 'local', 'seed-local-state.json');

function loadEnv() {
  const env = {};
  fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const i = t.indexOf('=');
    if (i === -1) return;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.slice(0, i).trim()] = v;
  });
  return env;
}
const env = loadEnv();
const AUTH = 'Basic ' + Buffer.from(
  env.LEARNUPON_PORTAL_API_USERNAME + ':' + env.LEARNUPON_PORTAL_API_PASSWORD).toString('base64');

// --- synchronous HTTP via curl ---------------------------------------------
// Credentials go in on stdin as a curl config file, never in argv where a process listing
// would show them.
let CALLS = 0;
function curlFetch(url, params) {
  CALLS++;
  const cfg = [
    'url = "' + url + '"',
    'request = "' + (params.method || 'get').toUpperCase() + '"',
    'header = "Authorization: ' +
      ((params.headers && params.headers.Authorization) || AUTH) + '"',
    'header = "Accept: application/json"',
    'silent',
    'show-error',
    'write-out = "\\n__STATUS__%{http_code}"'
  ];
  if (params.payload) {
    cfg.push('header = "Content-Type: application/json"');
    cfg.push('data-raw = ' + JSON.stringify(params.payload));
  }
  let out;
  try {
    out = execFileSync('curl', ['--config', '-'], { input: cfg.join('\n'), encoding: 'utf8', maxBuffer: 32e6 });
  } catch (e) {
    out = '\n__STATUS__000';
  }
  const at = out.lastIndexOf('__STATUS__');
  const status = Number(out.slice(at + 10).trim()) || 0;
  const text = out.slice(0, at).replace(/\n$/, '');
  return {
    getResponseCode: () => status,
    getContentText: () => text,
    getAllHeaders: () => ({})   // curl -i would give us these; the code treats absent as unknown
  };
}

// --- in-memory spreadsheet --------------------------------------------------
const sheets = { _Manifest: [], _Log: [], _Validation: [], _Preview: [] };
const say = [];

const stubs = `
var __h = __host;
function getSettings() { return __h.settings(); }
function getSetting(k, d) { var v = __h.settings()[k]; return (v === undefined || v === '') ? d : v; }
function currentEnvironment() { return 'test'; }
function environmentLabel() { return 'TEST (' + __h.subdomain + '.learnupon.com)'; }
function learnUponBase() { return 'https://' + __h.subdomain + '.learnupon.com/api/v1/'; }
function learnUponAuthHeader() { return __h.auth; }
function getCreds() { return { environment: 'test', subdomain: __h.subdomain, hubspotToken: __h.hsToken }; }
function activeUseCase() { return __h.settings().active_use_case || 'uc1'; }
function inScope_(uc, scope) { return scope === 'all' || String(uc).trim() === scope; }
function scopeLabel() { return activeUseCase(); }
function withScope_(uc, fn) { return fn(); }
function scenarioFor(uc) { return (__h.tabRows('Scenarios') || [])
  .filter(function (r) { return String(r.use_case).trim() === String(uc).trim(); })[0] || null; }
function scenarioExpectedFor() { return null; }
function tabRows(name) { return __h.tabRows(name); }
function replaceTabBody(name, rows) { __h.replaceTabBody(name, rows); }
function appendTabRows(name, rows) { __h.appendTabRows(name, rows); }
function nowIso() { return new Date().toISOString().replace(/\\.\\d+Z$/, 'Z'); }
function logAction(o) { __h.log(o); }
function uiAlert(t, m) { __h.say(t, m); }
function uiConfirmTyped(word, msg) { __h.say('CONFIRM (' + word + ')', msg); return true; }
function withLock(fn) { return fn(); }
function newRunId() { return 'local-' + (__h.runSeq++); }
function applyFormulas_() {}
var Logger = { log: function (m) { __h.say('log', String(m)); } };
var Utilities = {
  sleep: function (ms) { var end = Date.now() + ms; while (Date.now() < end) {} },
  base64Encode: function (s) { return __h.b64(s); },
  getUuid: function () { return 'uuid-' + (__h.runSeq++); },
  formatDate: function (d, tz, fmt) {
    const iso = new Date(d).toISOString();
    if (fmt === 'yyyy-MM-dd') return iso.slice(0, 10);
    return iso.slice(0, 19).replace(/[-:T]/g, '');
  }
};
var UrlFetchApp = { fetch: function (url, params) { return __h.fetch(url, params); } };
var LockService = { getScriptLock: function () {
  return { tryLock: function () { return true; }, releaseLock: function () {} }; } };
var SpreadsheetApp = {
  getActive: function () { return { toast: function () {} }; },
  getUi: function () {
    return {
      ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' },
      Button: { OK: 'OK' },
      alert: function (a, b) { __h.say(a, b || ''); return 'OK'; },
      prompt: function (a, b) { __h.say(a, b || ''); return {
        getSelectedButton: function () { return 'OK'; },
        getResponseText: function () { return __h.typed; } }; }
    };
  }
};
`;

// --- tiny scenario ----------------------------------------------------------
// One account, three users, one course. Enough to exercise every phase; small enough that the
// permanent records it leaves behind in the sandbox do not matter.
function tinyWorkbook(evalIn, settings) {
  const specs = evalIn('tabSpecs()');
  const TAB = evalIn('TAB');
  const cols = name => specs.filter(s => s.name === name)[0].cols.map(c => c.h);
  const obj = (name, row, i) => {
    const o = { _row: i + 2 };
    cols(name).forEach((h, j) => { o[h] = row[j] === undefined ? '' : row[j]; });
    return o;
  };

  const accounts = [obj(TAB.ACCOUNTS, ['tinyco', 'uc1', 'Tinyco Systems', 'tinyco-systems.com',
    'Software', 'in_flight', 'Growth', 1000, 'T-60', 'T+20', '', 3, 1, 33, '', '', '', 'harness'], 0)];
  accounts[0].lu_group_title = settings.group_title_prefix + 'Tinyco Systems';
  accounts[0].required_complete_actual = 33;

  const people = [
    obj(TAB.PEOPLE, ['tiny.dana', 'uc1', 'Dana', 'Probe', '', 'Platform Administrator', true, 'tinyco', ''], 0),
    obj(TAB.PEOPLE, ['tiny.priya', 'uc1', 'Priya', 'Probe', '', 'Operations Manager', false, 'tinyco', ''], 1)
  ];
  people.forEach(p => { p.email = (p.first_name + '.' + p.last_name + '@tinyco-systems.com').toLowerCase(); });

  const courses = [obj(TAB.COURSES, ['tiny-getting-started', 'uc1', 'Tinyco Getting Started', '',
    7788730, 'harness'], 0)];
  courses[0].reference_code = settings.course_ref_prefix + '-TINY-GETTING-STARTED';

  const enrollments = [obj(TAB.ENROLLMENTS, ['e1', 'uc1', 'tinyco', 'tiny-getting-started', 'all',
    '', 1, 0, '', 'G-30..G-10', 'S+5..S+20', '', '', 'harness'], 0)];
  enrollments[0].enroll_count = 3;
  enrollments[0].not_started_count = 2;

  const pins = [obj(TAB.PERSONA_STATES, ['p1', 'uc1', 'tiny.priya', 'tiny-getting-started',
    'completed', '', 'S+7', '', 'harness'], 0)];

  sheets[TAB.ACCOUNTS] = accounts;
  sheets[TAB.PEOPLE] = people;
  sheets[TAB.COURSES] = courses;
  sheets[TAB.ENROLLMENTS] = enrollments;
  sheets[TAB.PERSONA_STATES] = pins;
  sheets[TAB.TICKET_CATEGORIES] = [];
  sheets[TAB.TICKETS] = [];
  sheets[TAB.DEALS] = [];
}

// --- host -------------------------------------------------------------------
let settings = {};
const host = {
  subdomain: env.LEARNUPON_PORTAL_SUBDOMAIN,
  auth: AUTH,
  hsToken: env.HUBSPOT_TOKEN,
  runSeq: 1,
  typed: 'RESET ENROLLMENTS',
  settings: () => settings,
  b64: s => Buffer.from(s).toString('base64'),
  fetch: curlFetch,
  tabRows: name => JSON.parse(JSON.stringify(sheets[name] || [])),
  replaceTabBody: (name, rows) => {
    const cols = host.colsFor(name);
    sheets[name] = (rows || []).map((r, i) => {
      const o = { _row: i + 2 };
      cols.forEach((h, j) => { o[h] = r[j] === undefined ? '' : r[j]; });
      return o;
    });
  },
  appendTabRows: (name, rows) => {
    const cols = host.colsFor(name);
    sheets[name] = sheets[name] || [];
    (rows || []).forEach(r => {
      const o = { _row: sheets[name].length + 2 };
      cols.forEach((h, j) => { o[h] = r[j] === undefined ? '' : r[j]; });
      sheets[name].push(o);
    });
  },
  colsFor: null,
  log: o => sheets._Log.push(o),
  say: (t, m) => say.push({ t, m })
};

const context = vm.createContext({
  __host: host, console, JSON, Math, Date, String, Number, Object, Array,
  isNaN, parseInt, parseFloat, RegExp, Error, encodeURIComponent, Boolean
});

const source = FILES.map(f => '\n// ===== ' + f + ' =====\n' +
  fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
vm.runInContext(stubs + source, context, { filename: 'bundle.js' });
const evalIn = expr => vm.runInContext('(' + expr + ')', context);

const specs = evalIn('tabSpecs()');
host.colsFor = name => {
  const s = specs.filter(x => x.name === name)[0];
  return s ? s.cols.map(c => c.h) : [];
};

settings = {};
evalIn('SETTINGS_DEFAULTS').forEach(([k, v]) => { settings[k] = v; });
settings.course_owner_id = '32088202';
settings.t_anchor_mode = 'today';

const MODE = process.argv[2] || 'seed';
if (MODE.indexOf('hubspot') === 0) tinyHubSpotWorkbook(evalIn, settings);
else tinyWorkbook(evalIn, settings);

/**
 * A miniature scenario 2: one company, three named filers, two ticket categories (one with a
 * course, one a deliberate gap) across both comparison windows, and one deal.
 *
 * Small enough that the records it leaves in the DEVELOPER_TEST portal do not matter, and complete
 * enough to exercise every HubSpot phase including the associations and the archive path.
 */
function tinyHubSpotWorkbook(evalIn, settings) {
  const specs = evalIn('tabSpecs()');
  const TAB = evalIn('TAB');
  const cols = name => specs.filter(s => s.name === name)[0].cols.map(c => c.h);
  const obj = (name, row, i) => {
    const o = { _row: i + 2 };
    cols(name).forEach((h, j) => { o[h] = row[j] === undefined ? '' : row[j]; });
    return o;
  };

  settings.active_use_case = 'uc2';

  const accounts = [obj(TAB.ACCOUNTS, ['hsprobe', 'uc2', 'HS Probe Logistics', 'hsprobe-logistics.com',
    'Logistics and Supply Chain', 'established', 'Growth', 12000, 'T-300', 'S+60', 'S+60', 3, 1, 33, '', '', '',
    'harness'], 0)];
  accounts[0].lu_group_title = settings.group_title_prefix + 'HS Probe Logistics';
  accounts[0].required_complete_actual = 33;

  const people = [
    obj(TAB.PEOPLE, ['hsp.ada', 'uc2', 'Ada', 'Probe', '', 'Platform Administrator', true, 'hsprobe', ''], 0),
    obj(TAB.PEOPLE, ['hsp.femi', 'uc2', 'Femi', 'Probe', '', 'Operations Manager', false, 'hsprobe', ''], 1)
  ];
  people.forEach(p => { p.email = (p.first_name + '.' + p.last_name + '@hsprobe-logistics.com').toLowerCase(); });

  const courses = [obj(TAB.COURSES, ['hsp-integrations', 'uc2', 'HS Probe Integrations', '',
    7788730, 'harness'], 0)];
  courses[0].reference_code = settings.course_ref_prefix + '-HSP-INTEGRATIONS';

  const enrollments = [obj(TAB.ENROLLMENTS, ['e1', 'uc2', 'hsprobe', 'hsp-integrations', 'all',
    '', '', 1, 0, '', 'T-130..T-70', 'T-140..T-100', '', '', 'harness'], 0)];
  enrollments[0].enroll_count = 3;
  enrollments[0].not_started_count = 2;

  const cats = [
    obj(TAB.TICKET_CATEGORIES, ['integrations', 'Integrations', 'hsp-integrations',
      false, 'API returning 401 after key rotation|Webhook not firing on completion', 'harness'], 0),
    obj(TAB.TICKET_CATEGORIES, ['data-import', 'Data Import & Migration', '', true,
      'CSV import failing with no error message|Bulk upload times out', 'harness'], 1)
  ];

  const tickets = [
    obj(TAB.TICKETS, ['t1', 'uc2', 'hsprobe', 'integrations', 'T-180', 'T-91', 3,
      'hsp.ada,hsp.femi', 'MEDIUM', 'Closed', 10, 'harness'], 0),
    obj(TAB.TICKETS, ['t2', 'uc2', 'hsprobe', 'integrations', 'T-90', 'T-1', 1,
      'hsp.ada', 'MEDIUM', 'Closed', 10, 'harness'], 1),
    obj(TAB.TICKETS, ['t3', 'uc2', 'hsprobe', 'data-import', 'T-90', 'T-1', 2,
      'hsp.femi', 'HIGH', 'Waiting on us', 48, 'harness'], 2)
  ];

  const deals = [obj(TAB.DEALS, ['d1', 'uc2', 'hsprobe', 'Sales Pipeline', 'Qualified To Buy',
    12000, 'T+75', 'renewal', 'harness'], 0)];

  sheets[TAB.ACCOUNTS] = accounts;
  sheets[TAB.PEOPLE] = people;
  sheets[TAB.COURSES] = courses;
  sheets[TAB.ENROLLMENTS] = enrollments;
  sheets[TAB.PERSONA_STATES] = [];
  sheets[TAB.TICKET_CATEGORIES] = cats;
  sheets[TAB.TICKETS] = tickets;
  sheets[TAB.DEALS] = deals;
  sheets[TAB.SCENARIOS] = [obj(TAB.SCENARIOS, ['uc2', 'HubSpot probe', 'harness', '', 'testing', ''], 0)];
}

// --- run --------------------------------------------------------------------
function show(label) {
  console.log('\n' + '='.repeat(78) + '\n' + label + '\n' + '='.repeat(78));
  say.splice(0).forEach(s => console.log('[' + s.t + ']\n' + String(s.m).split('\n').map(l => '  ' + l).join('\n')));
}

function manifestTable() {
  console.log('\n  _Manifest (' + sheets._Manifest.length + ' rows)');
  sheets._Manifest.forEach(r => console.log('    ' + String(r.object_type).padEnd(12) +
    String(r.class).padEnd(11) + String(r.external_id).padEnd(12) + r.natural_key));
}

if (MODE === 'hubspot') {
  console.log('HubSpot portal: ' + (env.HUBSPOT_TOKEN ? 'token loaded' : 'NO TOKEN in .env'));

  evalIn('checkHubSpotCredentials()'); show('CHECK CONNECTION');
  evalIn('checkHubSpotPipelines()');   show('PIPELINES');
  evalIn('setupHubSpotProperties()');  show('PROPERTIES');
  evalIn('setupHubSpotPipelines()');   show('PIPELINES — create Onboarding');

  evalIn('previewSeedPlan()');         show('PREVIEW');

  evalIn('seedHubSpotCompanies()');    show('PHASE 5 — companies and contacts');
  evalIn('seedHubSpotTickets()');      show('PHASE 6 — tickets');
  evalIn('seedHubSpotDeals()');        show('PHASE 7 — deals');
  manifestTable();

  evalIn('verifyHubSpot()');           show('VERIFY HUBSPOT');
  evalIn('refreshHubSpotDates()');     show('REFRESH — must say nothing to do right after a seed');

  // Idempotency: a second run must create nothing.
  evalIn('seedHubSpotCompanies()');    show('PHASE 5 AGAIN — must say "nothing to do"');
  evalIn('seedHubSpotTickets()');      show('PHASE 6 AGAIN — must say "nothing to do"');

  fs.writeFileSync(STATE_PATH, JSON.stringify({ manifest: sheets._Manifest }, null, 2));
  console.log('\n  state written to ' + STATE_PATH + '  (run "hubspot-reset" to archive it all)');
  console.log('\n  HTTP calls: ' + CALLS);
  process.exit(0);
}

// Proves refresh MOVES dates, not just that it no-ops. Advancing T is exactly what the passage of
// time does to a seeded dataset, so this simulates being N days downstream of the seed.
if (MODE === 'hubspot-refresh') {
  const days = Number(process.argv[3] || 45);
  const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : { manifest: [] };
  sheets._Manifest = state.manifest || [];
  const future = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  settings.t_anchor_mode = 'pinned';
  settings.t_anchor_date = future;
  console.log('Pretending it is ' + future + ' (' + days + ' days after the seed)');
  console.log('Manifest rows: ' + sheets._Manifest.length);

  evalIn('verifyHubSpot()');        show('VERIFY BEFORE — should complain the dates have drifted');
  evalIn('refreshHubSpotDates()');  show('REFRESH');
  evalIn('verifyHubSpot()');        show('VERIFY AFTER — should be clean');
  evalIn('refreshHubSpotDates()');  show('REFRESH AGAIN — must be a no-op, not another shift');

  fs.writeFileSync(STATE_PATH, JSON.stringify({ manifest: sheets._Manifest }, null, 2));
  console.log('\n  HTTP calls: ' + CALLS);
  process.exit(0);
}

if (MODE === 'hubspot-reset') {
  const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : { manifest: [] };
  sheets._Manifest = state.manifest || [];
  host.typed = 'RESET UC2';
  console.log('Manifest rows loaded: ' + sheets._Manifest.length);
  evalIn('resetHubSpot()');            show('RESET HUBSPOT');
  manifestTable();
  fs.writeFileSync(STATE_PATH, JSON.stringify({ manifest: sheets._Manifest }, null, 2));
  console.log('\n  HTTP calls: ' + CALLS);
  process.exit(0);
}

if (process.argv[2] === 'teardown') {
  const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : { manifest: [] };
  console.log('Tearing down ' + state.manifest.length + ' recorded object(s)');
  const del = (type, id) => {
    const r = curlFetch('https://' + host.subdomain + '.learnupon.com/api/v1/' + type + '/' + id,
      { method: 'delete' });
    console.log('  ' + type + '/' + id + ' -> HTTP ' + r.getResponseCode());
  };
  state.manifest.filter(m => m.object_type === 'course').forEach(m => del('courses', m.external_id));
  state.manifest.filter(m => m.object_type === 'group').forEach(m => del('groups', m.external_id));
  console.log('\n  Users and completed enrollments are never deleted — remove in the UI if needed.');
  process.exit(0);
}

if (process.argv[2] === 'refresh') {
  // Seed, then jump the anchor forward a month and prove the due dates follow it.
  vm.runInContext('seedUsersAndGroups()', context);
  vm.runInContext('seedCourses()', context);
  vm.runInContext('seedEnrollments()', context);
  vm.runInContext('seedCompletions()', context);
  say.splice(0);
  const days = Number(process.argv[3] || 30);
  const future = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  console.log('Seeded the tiny scenario. Now moving the anchor forward ' + days + ' days.\n');
  settings.t_anchor_mode = 'pinned';
  settings.t_anchor_date = future;
  console.log('  anchor T is now ' + future + '\n');

  // Show exactly what the plan wants vs what the portal holds, before refresh decides anything.
  const dbg = vm.runInContext(`(function () {
    var plan = expand(loadWorkbook());
    var idx = manifestIndex();
    return plan.learnupon.enrollments.map(function (e) {
      var row = idx[e.natural_key];
      return { email: e.email, want: e.due_date ? ymd(e.due_date) : null,
               id: row ? row.external_id : null };
    });
  })()`, context);
  console.log('  plan wants (anchor ' + future + '):');
  dbg.forEach(d => console.log('    ' + d.email + '  want ' + d.want + '  enrollment ' + d.id));
  console.log('');

  vm.runInContext('refreshDueDates()', context); show('REFRESH');
  vm.runInContext('verifySeed()', context); show('VERIFY after refresh');
  fs.writeFileSync(STATE_PATH, JSON.stringify({ manifest: sheets._Manifest }, null, 2));
  console.log('\n' + CALLS + ' API calls.');
  process.exit(0);
}

vm.runInContext('seedUsersAndGroups()', context); show('PHASE 1 — users, groups, memberships');
vm.runInContext('seedCourses()', context); show('PHASE 2 — courses');
vm.runInContext('seedEnrollments()', context); show('PHASE 3 — enrollments');
vm.runInContext('seedCompletions()', context); show('PHASE 4 — completions');
manifestTable();

vm.runInContext('verifySeed()', context); show('VERIFY (after seed)');
vm.runInContext('resetEnrollments()', context); show('RESET');
vm.runInContext('verifySeed()', context); show('VERIFY (after reset)');
manifestTable();

fs.writeFileSync(STATE_PATH, JSON.stringify({ manifest: sheets._Manifest }, null, 2));
console.log('\n' + CALLS + ' API calls. State written for teardown.');
