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
    e.enroll_count = String(e.enroll_count_override) !== '' && e.enroll_count_override !== undefined
      ? Number(e.enroll_count_override)
      : (acct ? Number(e.audience === 'admins' ? acct.admin_count : acct.user_count) : '');
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
  console.log('  ' + c.title + '   ref=' + c.reference_code +
    '   module ' + (c.source_module_id || 'MISSING')));

// The first account in the plan, whichever scenario is loaded. Hard-coding uc1's accounts here
// meant the sample section crashed the moment a second scenario was written.
const firstAccount = (plan.stats.byAccount[0] || {}).account_key;
if (firstAccount) {
  const users = plan.learnupon.users.filter(u => u.account_key === firstAccount);
  console.log('\n' + firstAccount + ' users (first 8 of ' + users.length + ')');
  users.slice(0, 8).forEach(u =>
    console.log('  ' + (u.email + '                                   ').slice(0, 40) +
      (u.is_admin ? '[admin] ' : '        ') + u.job_title));
}

console.log('\nEnrollment matrix — account x course');
const courseKeys = plan.learnupon.courses.map(c => c.course_key);
plan.stats.byAccount.forEach(a => {
  courseKeys.forEach(ck => {
    const set = plan.learnupon.enrollments.filter(e =>
      e.account_key === a.account_key && e.course_key === ck);
    if (!set.length) return;
    const n = s => set.filter(e => e.status === s).length;
    console.log('  ' + (a.account_key + '              ').slice(0, 14) +
      (ck + '                          ').slice(0, 26) +
      'enrolled ' + String(set.length).padStart(3) +
      '   done ' + String(n('completed')).padStart(3) +
      '   not started ' + String(n('not_started')).padStart(3) +
      '   overdue ' + String(set.filter(e => e.overdue).length).padStart(3));
  });
});

const done = plan.learnupon.enrollments.filter(e => e.date_completed)
  .map(e => new Date(e.date_completed).getTime());
if (done.length) {
  console.log('\nCompletion window: ' + fmt(Math.min.apply(null, done)) +
    '  ->  ' + fmt(Math.max.apply(null, done)));
}

// --- HubSpot -----------------------------------------------------------------
const h = plan.hubspot;
if (h.tickets.length || h.companies.length) {
  console.log('\n' + '='.repeat(78));
  console.log('HUBSPOT');
  console.log('='.repeat(78));

  console.log('\nCompanies');
  h.companies.forEach(c => console.log('  ' + (c.name + '                              ').slice(0, 30) +
    (c.domain + '                          ').slice(0, 26) +
    'live ' + fmt(c.actual_go_live_date)));

  if (h.tickets.length) {
    const T = new Date(plan.anchor + 'T00:00:00Z').getTime();
    const DAY = 86400000;
    const recent = t => (T - new Date(t.created_at).getTime()) / DAY <= 90;

    console.log('\nTickets by category — the Story 1 and Story 2 table');
    console.log('  ' + 'category'.padEnd(26) + 'prior 90d'.padStart(10) +
      'last 90d'.padStart(10) + '   change   has course');
    const cats = {};
    h.tickets.forEach(t => {
      const c = cats[t.category_label] = cats[t.category_label] || { r: 0, p: 0, key: t.category_key };
      if (recent(t)) c.r++; else c.p++;
    });
    const catRows = sheetState['TicketCategories'] || [];
    const courseFor = k => (catRows.filter(c => c.category_key === k)[0] || {}).course_key || '';
    Object.keys(cats).sort((a, b) => cats[b].r - cats[a].r).forEach(label => {
      const c = cats[label];
      const delta = c.p ? Math.round(100 * (c.r - c.p) / c.p) : 0;
      console.log('  ' + label.padEnd(26) + String(c.p).padStart(10) + String(c.r).padStart(10) +
        '   ' + (delta > 0 ? '+' : '') + String(delta).padStart(4) + '%   ' +
        (courseFor(c.key) ? courseFor(c.key) : '*** NO COURSE ***'));
    });

    console.log('\nIntegrations tickets by account — did training deflect them?');
    console.log('  ' + 'account'.padEnd(14) + 'prior'.padStart(7) + 'last90'.padStart(8) +
      '   masterclass completions');
    plan.stats.byAccount.forEach(a => {
      const mine = h.tickets.filter(t => t.account_key === a.account_key &&
        t.category_key === 'integrations');
      if (!mine.length) return;
      const mc = plan.learnupon.enrollments.filter(e => e.account_key === a.account_key &&
        e.course_key === 'kb-integrations' && e.status === 'completed').length;
      console.log('  ' + a.account_key.padEnd(14) +
        String(mine.filter(t => !recent(t)).length).padStart(7) +
        String(mine.filter(recent).length).padStart(8) + '   ' + mc);
    });

    const totals = { recent: h.tickets.filter(recent).length, prior: h.tickets.filter(t => !recent(t)).length };
    console.log('\n  totals: ' + totals.prior + ' prior, ' + totals.recent + ' in the last 90 days');

    const noFiler = h.tickets.filter(t => !t.contact_email).length;
    if (noFiler) console.log('  WARNING: ' + noFiler + ' ticket(s) have no contact to file them.');
  }

  if (h.deals.length) {
    console.log('\nDeals');
    h.deals.forEach(d => console.log('  ' + d.name + '   ' + d.amount +
      '   closes ' + fmt(d.close_date) + '   ' + d.stage_label));
  }
}

console.log('\n_Preview rows: ' + r.previewRows);

const failed = r.tests.failed + r.validation.errors;
if (failed > 0) {
  console.log('\nFAILED: ' + r.tests.failed + ' test failure(s), ' + r.validation.errors + ' validation error(s).');
  process.exit(1);
}
console.log('\nOK: ' + r.tests.passed + ' tests passed, no validation errors.');
