#!/usr/bin/env node
/**
 * verify-local.js — runs the pure Apps Script layers under Node, with the Sheets API stubbed out.
 *
 * We develop without clasp, so this is the only way to exercise Dates / Random / Expand / Validate /
 * Scenario1 without pasting into the editor and clicking. It builds an in-memory workbook from
 * Scenario1.gs (computing the formula columns exactly as the sheet does), then runs the unit tests
 * and prints the plan summary and validation results.
 *
 *   node tools/verify-local.js          scenario 1 (default)
 *   node tools/verify-local.js uc2      scenario 2
 *
 * It cannot test anything that touches SpreadsheetApp, UrlFetchApp or PropertiesService — that is
 * the trade-off, and it is why Schema.gs and Config.gs still need a real run in the editor.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'apps-script');
const FILES = ['Schema.gs', 'Random.gs', 'Dates.gs', 'Expand.gs', 'Validate.gs',
  'ScenarioLoader.gs', 'Scenario1.gs', 'Scenario2.gs', 'Scenario3.gs', 'Tests.gs'];

// node tools/verify-local.js [uc1|uc2|uc3]
const UC = (process.argv[2] || 'uc1').trim();
const N = UC.replace('uc', '');

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const ANCHOR = '2026-09-01'; // pinned so output is stable run to run

const sheetState = {};   // tabName -> array of row objects
const written = {};      // tabName -> last rows2d written by the code under test
const logs = [];
const alerts = [];

const stubs = `
var __sheetState = __host.sheetState;
var __written = __host.written;

function getSettings() { return __host.settings(); }
function getSetting(k, d) { var v = __host.settings()[k]; return (v === undefined || v === '') ? d : v; }
function currentEnvironment() { return 'test'; }
function activeUseCase() { return __host.settings().active_use_case || 'uc1'; }
function inScope_(uc, scope) { return scope === 'all' || String(uc).trim() === scope; }
function scenarioFor(uc) { return (__host.tabRows('Scenarios') || [])
  .filter(function (r) { return String(r.use_case).trim() === String(uc).trim(); })[0] || null; }
function scopeLabel() { return activeUseCase(); }
function environmentLabel() { return 'TEST (local harness)'; }
function tabRows(name) {
  if (!__sheetState[name]) return [];
  return JSON.parse(JSON.stringify(__sheetState[name]), function (k, v) {
    return (typeof v === 'string' && /^\\d{4}-\\d{2}-\\d{2}T/.test(v)) ? new Date(v) : v;
  });
}
function replaceTabBody(name, rows) { __written[name] = rows; }
function appendTabRows(name, rows) { __written[name] = (__written[name] || []).concat(rows); }
function nowIso() { return '2026-09-01T00:00:00Z'; }
function logAction(o) { __host.logs.push(o); }
function uiAlert(title, msg) { __host.alerts.push({ title: title, msg: msg }); }
function uiConfirmTyped() { return true; }
function withLock(fn) { return fn(); }
function newRunId() { return 'local-run'; }
function applyFormulas_() {}
var Logger = { log: function (m) { __host.logs.push({ notes: String(m) }); } };
var SpreadsheetApp = {
  getActive: function () { return { toast: function () {}, getSheetByName: function () { return null; } }; },
  getUi: function () { throw new Error('no UI in the local harness'); }
};
`;

const runner = `
__host.result = { tests: null, plan: null, summary: null, validation: null };
__host.result.tests = runAllTests();
var plan = scopedPlan();   // exercises the scoping code, not just expand()
__host.result.plan = plan;
__host.result.summary = planSummary(plan);
__host.result.validation = validateWorkbook({ silent: true });
__host.result.validationRows = __written['_Validation'] || [];
__host.result.previewRows = (writePreview(plan), (__written['_Preview'] || []).length);
`;

// ---------------------------------------------------------------------------
// Build the in-memory workbook, computing formula columns like the sheet does
// ---------------------------------------------------------------------------

// `const` declared at the top level of a vm script lives in the context's lexical scope, not on the
// sandbox object, so reach it by evaluating an expression rather than by property access.
function buildWorkbook(evalIn) {
  const settings = {};
  evalIn('SETTINGS_DEFAULTS').forEach(([k, v]) => { settings[k] = v; });
  settings.course_owner_id = '32088202';
  settings.active_use_case = UC;
  settings.t_anchor_mode = 'pinned';
  settings.t_anchor_date = ANCHOR;

  const specs = evalIn('tabSpecs()');
  const specOf = name => specs.filter(s => s.name === name)[0];
  const toObjects = (name, rows2d) => {
    const cols = specOf(name).cols.map(c => c.h);
    return rows2d.map((r, i) => {
      const o = { _row: i + 2 };
      cols.forEach((h, j) => { o[h] = r[j] === undefined ? '' : r[j]; });
      return o;
    });
  };

  const T = evalIn('TAB');
  // Each scenario file exposes scenarioNAccounts_ and friends; missing ones mean an empty scenario.
  const build = name => {
    try { return evalIn('scenario' + N + name + '_()') || []; }
    catch (e) { return []; }
  };
  const accounts = toObjects(T.ACCOUNTS, build('Accounts'));
  const people = toObjects(T.PEOPLE, build('People'));
  const courses = toObjects(T.COURSES, build('Courses'));
  const enrollments = toObjects(T.ENROLLMENTS, build('Enrollments'));

  // --- formula columns -----------------------------------------------------
  const acctByKey = {};
  accounts.forEach(a => { acctByKey[a.account_key] = a; });

  accounts.forEach(a => { a.lu_group_title = settings.group_title_prefix + a.company_name; });

  people.forEach(p => {
    const acct = acctByKey[p.account_key];
    p.email = (p.first_name + '.' + p.last_name + '@' +
      (acct ? acct.domain : 'MISSING-ACCOUNT')).toLowerCase();
  });

  courses.forEach(c => {
    c.reference_code = settings.course_ref_prefix + '-' + String(c.course_key).toUpperCase();
  });

  enrollments.forEach(e => {
    const acct = acctByKey[e.account_key];
    e.enroll_count = acct ? Number(e.audience === 'admins' ? acct.admin_count : acct.user_count) : '';
    e.not_started_count = e.enroll_count === ''
      ? '' : Math.max(0, e.enroll_count - Number(e.completed_count || 0) - Number(e.in_progress_count || 0));
  });

  accounts.forEach(a => {
    const mine = enrollments.filter(e => e.account_key === a.account_key);
    const total = mine.reduce((s, e) => s + Number(e.enroll_count || 0), 0);
    const done = mine.reduce((s, e) => s + Number(e.completed_count || 0), 0);
    a.required_complete_actual = total ? Math.round(100 * done / total) : '';
  });

  sheetState[T.ACCOUNTS] = accounts;
  sheetState[T.PEOPLE] = people;
  sheetState[T.COURSES] = courses;
  sheetState[T.ENROLLMENTS] = enrollments;
  sheetState[T.PERSONA_STATES] = toObjects(T.PERSONA_STATES, build('PersonaStates'));
  sheetState[T.TICKET_CATEGORIES] = toObjects(T.TICKET_CATEGORIES, build('Categories'));
  sheetState[T.TICKETS] = toObjects(T.TICKETS, build('Tickets'));
  sheetState[T.DEALS] = toObjects(T.DEALS, build('Deals'));

  let meta = { use_case: UC, name: UC, owner_name: '' };
  try { meta = evalIn('scenario' + N + 'Meta()') || meta; } catch (e) { /* skeleton */ }
  sheetState[T.SCENARIOS] = [{ _row: 2, use_case: UC, scenario_name: meta.name,
    owner_name: meta.owner_name || '', owner_email: '', status: 'designing', notes: '' }];
  sheetState[T.MANIFEST] = [];

  return settings;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const source = FILES.map(f => '\n// ===== ' + f + ' =====\n' + fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

let settings = {};
const host = {
  sheetState: sheetState,
  written: written,
  logs: logs,
  alerts: alerts,
  settings: () => settings,
  result: null
};

const context = vm.createContext({ __host: host, console: console, JSON: JSON, Math: Math, Date: Date, String: String, Number: Number, Object: Object, Array: Array, isNaN: isNaN, parseInt: parseInt, RegExp: RegExp, Error: Error });

// Phase 1: load definitions so we can call the scenario builders to construct the workbook.
vm.runInContext(stubs + source, context, { filename: 'apps-script-bundle.js' });
const evalIn = expr => vm.runInContext('(' + expr + ')', context);
settings = buildWorkbook(evalIn);

// Phase 2: exercise the pipeline.
vm.runInContext(runner, context, { filename: 'runner.js' });

const r = host.result;
const testAlert = alerts.filter(a => a.title === 'Unit tests')[0];

console.log('Scenario: ' + UC + (host.result && host.result.plan &&
  !host.result.plan.learnupon.users.length ? '   (no data in this scenario file yet)' : ''));
console.log('='.repeat(78));
console.log('UNIT TESTS');
console.log('='.repeat(78));
console.log(testAlert ? testAlert.msg : '(no test output)');

console.log('\n' + '='.repeat(78));
console.log('PLAN SUMMARY   (anchor pinned to ' + ANCHOR + ')');
console.log('='.repeat(78));
console.log(r.summary);

console.log('\n' + '='.repeat(78));
console.log('VALIDATION   ' + r.validation.errors + ' error(s), ' + r.validation.warnings + ' warning(s)');
console.log('='.repeat(78));
(r.validationRows || []).forEach(row => {
  console.log('[' + row[1] + '] ' + row[2] + (row[3] ? ' row ' + row[3] : '') +
    (row[4] ? ' · ' + row[4] : '') + '\n    ' + row[5]);
});
console.log('\n' + '='.repeat(78));
console.log('SAMPLE RECORDS   (eyeball these — they are what lands in the portal)');
console.log('='.repeat(78));

const plan = r.plan;
const fmt = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');

console.log('\nGroups');
plan.learnupon.groups.slice(0, 3).forEach(g => console.log('  "' + g.title + '"'));

console.log('\nCourses');
plan.learnupon.courses.forEach(c =>
  console.log('  ' + c.title + '   ref=' + c.reference_code + '   clone from ' + c.clone_source_course_id));

console.log('\nAlderfield users (first 8 of 16)');
plan.learnupon.users.filter(u => u.account_key === 'alderfield').slice(0, 8).forEach(u =>
  console.log('  ' + (u.email + '                                   ').slice(0, 38) +
    (u.is_admin ? '[admin] ' : '        ') + u.job_title));

console.log('\nAlderfield — Getting Started with ACME (the 16/6/4/6 matrix)');
const gs = plan.learnupon.enrollments.filter(e =>
  e.account_key === 'alderfield' && e.course_key === 'nce-getting-started');
['completed', 'in_progress', 'not_started'].forEach(s => {
  const n = gs.filter(e => e.status === s).length;
  console.log('  ' + (s + '            ').slice(0, 13) + n +
    '   overdue: ' + gs.filter(e => e.status === s && e.overdue).length);
});

console.log('\nAlderfield — the three blockers');
['alderfield.dana', 'alderfield.marcus', 'alderfield.tom'].forEach(pk => {
  console.log('  ' + pk);
  plan.learnupon.enrollments
    .filter(e => e.user_natural_key === 'user:person:' + pk)
    .forEach(e => console.log('      ' + (e.course_title + '                                  ').slice(0, 34) +
      (e.status + '           ').slice(0, 12) +
      'due ' + fmt(e.due_date) + (e.overdue ? ' OVERDUE' : '        ') +
      (e.percentage !== null && e.status === 'in_progress' ? '  ' + e.percentage + '%' : '') +
      (e.date_completed ? '  completed ' + fmt(e.date_completed) : '') +
      (e.date_last_accessed ? '  last seen ' + fmt(e.date_last_accessed) : '')));
});

console.log('\nEstablished cohort — onboarding duration');
['cobaltpeak', 'fernpath', 'harborline', 'halden', 'larkspur', 'northwind'].forEach(key => {
  const done = plan.learnupon.enrollments
    .filter(e => e.account_key === key && e.date_completed)
    .map(e => new Date(e.date_completed).getTime());
  const acct = sheetState['Accounts'].filter(a => a.account_key === key)[0];
  console.log('  ' + (key + '            ').slice(0, 13) +
    'core training finished ' + fmt(Math.max.apply(null, done)) +
    '   go-live ' + acct.actual_go_live_offset);
});

console.log('\n_Preview rows: ' + r.previewRows);

const failed = r.tests.failed + r.validation.errors;
if (failed > 0) {
  console.log('\nFAILED: ' + r.tests.failed + ' test failure(s), ' + r.validation.errors + ' validation error(s).');
  process.exit(1);
}
console.log('\nOK: ' + r.tests.passed + ' tests passed, no validation errors.');
