#!/usr/bin/env node
/**
 * spike.js — resolves the API unknowns the design depends on, against the throwaway portal.
 *
 * This is the ONLY tool in the repo that writes to a portal. It obeys the same rule the toolkit
 * does: it records every object it creates in apps-script/local/spike-manifest.json, and `cleanup`
 * deletes only what is in that file. It never searches the portal for things to remove, and it
 * never deletes a user.
 *
 * Endpoint shapes here were read off the docs HTML, not guessed. LearnUpon's v1 API is mostly FLAT
 * (POST /courses/clone, not POST /courses/{id}/clone) and its search endpoints are /search
 * (GET /users/search?email=, not GET /users?email=). Unrecognised query params are ignored and the
 * endpoint returns everything, so filtered reads are always verified against the id we asked for.
 *
 *   node tools/spike.js clone      spike 4 — clone, rename, publish
 *   node tools/spike.js user       create the one spike learner
 *   node tools/spike.js enroll     spike 2 — is enrollment created_at settable?
 *   node tools/spike.js complete   spike 1a — backdated completion
 *   node tools/spike.js progress   spike 1b — can we fabricate an in-progress enrollment?
 *   node tools/spike.js delete     spike 3 — can a Completed enrollment be deleted?
 *   node tools/spike.js report     read everything back
 *   node tools/spike.js cleanup    delete only what this script created
 */

'use strict';
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', 'apps-script', 'local', '.env');
const MANIFEST_PATH = path.join(__dirname, '..', 'apps-script', 'local', 'spike-manifest.json');
const SOURCE_COURSE = 5128555;
const SPIKE_EMAIL = 'mcpdemo.spike@alderfield-financial.com';
const SPIKE_TAG = 'MCPDEMO-SPIKE';

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
const BASE = 'https://' + env.LEARNUPON_PORTAL_SUBDOMAIN + '.learnupon.com/api/v1/';
const AUTH = 'Basic ' + Buffer.from(
  env.LEARNUPON_PORTAL_API_USERNAME + ':' + env.LEARNUPON_PORTAL_API_PASSWORD).toString('base64');

function manifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return { courses: [], users: [], enrollments: [], guid: null };
  const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  m.courses = m.courses || []; m.users = m.users || [];
  m.enrollments = m.enrollments || []; m.guid = m.guid || null;
  return m;
}
function save(m) { fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2)); }
function record(kind, value) {
  const m = manifest();
  if (m[kind].map(String).indexOf(String(value)) === -1) m[kind].push(value);
  save(m);
  console.log('    [manifest] ' + kind + ' += ' + value);
}
function unrecord(kind, value) {
  const m = manifest();
  m[kind] = m[kind].filter(v => String(v) !== String(value));
  save(m);
}

let lastCall = 0;
async function api(method, urlPath, body, opts) {
  opts = opts || {};
  const wait = 250 - (Date.now() - lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();

  const headers = { Authorization: AUTH, Accept: 'application/json' };
  const init = { method: method, headers: headers };
  if (body) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }

  const res = await fetch(BASE + urlPath, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* html error page */ }

  if (!opts.quiet) {
    console.log('    ' + method + ' /' + urlPath + '  ->  HTTP ' + res.status);
    if (opts.show !== false) {
      let out = json ? JSON.stringify(json, null, 2) : text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const lim = opts.limit || 700;
      if (out.length > lim) out = out.slice(0, lim) + ' ...truncated';
      console.log('    ' + out.split('\n').join('\n    '));
    }
  }
  return { status: res.status, json: json, text: text };
}

const ymd = d => d.toISOString().slice(0, 10);
const daysAgo = n => ymd(new Date(Date.now() - n * 86400000));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function header(title, note) {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  if (note) console.log(note);
  console.log('='.repeat(78));
}

/**
 * The guid arrives either as a field on a 200, or embedded in the message of a 400 that reads
 * "add '?guid=xxx' to the end of the api call". Both are normal, expected responses.
 */
function extractGuid_(json) {
  if (!json) return null;
  if (json.guid) return String(json.guid);
  const text = String(json.message || '') + ' ' + String(json.error || '');
  const m = text.match(/guid=([\w-]+)/);
  return m ? m[1] : null;
}

/** Clone once using the guid, wait for it to land, then rename and tag it. */
async function cloneOne(name, referenceCode) {
  const m = manifest();
  const before = new Set((await courseIds()).map(String));
  const q = m.guid ? 'courses/clone?guid=' + m.guid : 'courses/clone';
  const r = await api('POST', q, { course_id: SOURCE_COURSE, publish_after_clone: true }, { limit: 400 });
  const guid = extractGuid_(r.json);
  if (guid && !m.guid) { m.guid = guid; save(m); }

  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const created = (await courseIds()).filter(id => !before.has(String(id)));
    process.stdout.write('    waiting ' + ((i + 1) * 5) + 's...\r');
    if (created.length) {
      const id = created[0];
      console.log('\n    new course id ' + id);
      record('courses', id);
      await api('PUT', 'courses/' + id,
      { Course: { name: name, reference_code: referenceCode } }, { quiet: true });
      const c = await getCourse(id);
      console.log('    -> "' + (c && c.name) + '"  ref=' + (c && c.reference_code) +
        '  modules=' + (c && c.number_of_modules) +
        '  published=' + (c && c.date_published ? c.date_published.slice(0, 10) : 'NO'));
      return id;
    }
  }
  console.log('\n    timed out waiting for the clone to appear');
  return null;
}

async function courseIds() {
  const r = await api('GET', 'courses', null, { quiet: true });
  return (r.json && r.json.courses || []).map(c => c.id);
}
async function getCourse(id) {
  const r = await api('GET', 'courses?course_id=' + id, null, { quiet: true });
  const list = (r.json && r.json.courses) || [];
  return list.filter(c => String(c.id) === String(id))[0] || null;   // never trust the filter
}

// ---------------------------------------------------------------------------
// Spike 4 — clone, rename, publish
// ---------------------------------------------------------------------------

async function spikeClone() {
  header('SPIKE 4 — POST /courses/clone, then PUT /courses/{id} to rename, then publish',
    'Clone is ASYNC and returns a guid, not a course id. Second clone of the same source needs\n' +
    'that guid in the query string, and the reminder arrives as an ERROR response.');

  const before = await courseIds();
  console.log('\n1. First clone (' + before.length + ' courses in the portal beforehand)');
  const first = await api('POST', 'courses/clone', {
    course_id: SOURCE_COURSE, publish_after_clone: false
  });
  const guid = extractGuid_(first.json);
  if (guid) { const m = manifest(); m.guid = guid; save(m); console.log('    [manifest] guid = ' + guid); }

  console.log('\n2. Second clone of the same source — expect the "already copied" error carrying a guid');
  const second = await api('POST', 'courses/clone', { course_id: SOURCE_COURSE });
  const guid2 = extractGuid_(second.json);
  if (guid2) { const m = manifest(); m.guid = m.guid || guid2; save(m); console.log('    guid from error: ' + guid2); }

  const useGuid = manifest().guid;
  if (useGuid) {
    console.log('\n3. Third clone, passing the guid in the query string');
    await api('POST', 'courses/clone?guid=' + useGuid, { course_id: SOURCE_COURSE });
    console.log('\n4. Fourth clone');
    await api('POST', 'courses/clone?guid=' + useGuid, { course_id: SOURCE_COURSE });
  }

  console.log('\n5. Polling for the new courses to appear (cloning is async, docs say ~5 min)');
  const beforeSet = new Set(before.map(String));
  let created = [];
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const now = await courseIds();
    created = now.filter(id => !beforeSet.has(String(id)));
    process.stdout.write('    +' + ((i + 1) * 5) + 's: ' + created.length + ' new course(s)\r');
    if (created.length >= 2) break;
  }
  console.log('\n    New course ids: ' + JSON.stringify(created));
  created.forEach(id => record('courses', id));

  if (!created.length) {
    console.log('    Nothing yet. Re-run `node tools/spike.js report` in a few minutes.');
    return;
  }

  console.log('\n6. Rename + tag the first clone via PUT /courses/{id}');
  const target = created[0];
  await api('PUT', 'courses/' + target, {
    name: 'Getting Started with ACME',
    reference_code: 'MCPDEMO-NCE-GETTING-STARTED'
  });
  const renamed = await getCourse(target);
  console.log('    -> name="' + (renamed && renamed.name) + '"  reference_code=' +
    (renamed && renamed.reference_code) + '  modules=' + (renamed && renamed.number_of_modules));

  console.log('\n7. Publish it');
  await api('POST', 'courses/publish', { course_id: target });
  const published = await getCourse(target);
  console.log('    -> date_published=' + (published && published.date_published));
}

// ---------------------------------------------------------------------------
// Spike learner
// ---------------------------------------------------------------------------

async function spikeUser() {
  header('Create the spike learner, and confirm CustomData writes by LABEL');

  const found = await api('GET', 'users/search?email=' + encodeURIComponent(SPIKE_EMAIL), null, { quiet: true });
  const list = (found.json && (found.json.user || found.json.users)) || [];
  const existing = list.filter(u => u.email === SPIKE_EMAIL)[0];
  if (existing) {
    console.log('    Already exists: user ' + existing.id);
    record('users', existing.id);
    return existing.id;
  }

  const r = await api('POST', 'users', {
    User: {
      email: SPIKE_EMAIL, first_name: 'Spike', last_name: 'Probe',
      password: 'Sp1ke-Probe-' + Date.now(), language: 'en', user_type: 'learner',
      CustomData: { 'Job Title': 'Platform Administrator', demo_source: SPIKE_TAG }
    }
  });
  const id = r.json && (r.json.id || (r.json.user && r.json.user.id));
  if (id) record('users', id);

  console.log('\n    Reading back — did CustomData land, keyed by label?');
  const back = await api('GET', 'users/search?email=' + encodeURIComponent(SPIKE_EMAIL), null, { quiet: true });
  const u = ((back.json && (back.json.user || back.json.users)) || []).filter(x => x.email === SPIKE_EMAIL)[0];
  console.log('    CustomData: ' + JSON.stringify(u && u.CustomData));
  return id;
}

// ---------------------------------------------------------------------------
// Spike 2 — created_at
// ---------------------------------------------------------------------------

async function spikeEnroll() {
  header('SPIKE 2 — is enrollment created_at settable?',
    'The docs list only re_enroll_if_completed, due_date and expires_at as optional. Sending\n' +
    'created_at anyway tells us whether it is silently accepted, silently ignored, or rejected.');

  const m0 = manifest();
  const courseId = process.argv[3] || m0.courses[m0.courses.length - 1];
  if (!courseId) { console.log('    Run `build` first.'); return; }
  console.log('    using course ' + courseId);

  const r = await api('POST', 'enrollments', {
    Enrollment: {
      email: SPIKE_EMAIL, course_id: courseId,
      due_date: daysAgo(18), created_at: daysAgo(47)
    }
  });
  const id = r.json && (r.json.id || (r.json.enrollment && r.json.enrollment.id));
  if (id) record('enrollments', id);
  if (!id) return;

  const back = await api('GET', 'enrollments/' + id, null, { limit: 900 });
  const e = back.json && (back.json.enrollment || back.json.enrollments && back.json.enrollments[0] || back.json);
  console.log('\n    asked for created_at = ' + daysAgo(47));
  console.log('    got     created_at = ' + (e && e.created_at));
  console.log('    due_date            = ' + (e && e.due_date));
  console.log('    VERDICT: created_at is ' +
    (e && String(e.created_at).slice(0, 10) === daysAgo(47) ? 'SETTABLE' : 'NOT settable — ignored'));
}

// ---------------------------------------------------------------------------
// Spike 1a — backdated completion
// ---------------------------------------------------------------------------

async function spikeComplete() {
  header('SPIKE 1a — backdated completion via POST /markcompletes');
  const me = manifest().enrollments;
  const id = process.argv[3] || me[me.length - 1];
  if (!id) { console.log('    Run `enroll` first.'); return; }
  console.log('    using enrollment ' + id);

  const when = daysAgo(30);
  // percentage must be OMITTED for status "completed" — it is a score, and only passed/failed take it
  await api('POST', 'markcompletes', {
    Markcomplete: { enrollment_id: id, date_completed: when + 'T12:00:00Z', status: 'completed' }
  }, { limit: 400 });

  const back = await api('GET', 'enrollments/' + id, null, { quiet: true });
  const e = back.json && (back.json.enrollment || back.json.enrollments && back.json.enrollments[0] || back.json);
  console.log('    asked for date_completed = ' + when);
  console.log('    got     date_completed = ' + (e && e.date_completed));
  console.log('    status = ' + (e && (e.status || e.status_id)) + '   percentage = ' + (e && e.percentage));
  console.log('    VERDICT: backdating ' +
    (e && String(e.date_completed).slice(0, 10) === when ? 'WORKS' : 'FAILED'));
}

// ---------------------------------------------------------------------------
// Spike 1b — in progress
// ---------------------------------------------------------------------------

async function spikeProgress() {
  header('SPIKE 1b — can we fabricate an IN PROGRESS enrollment?',
    'The one the design most depends on: Marcus Feld is "30% through, stalled 22 days", and every\n' +
    'in-progress count in Story 1 needs this. Docs say markcompletes status accepts only\n' +
    'completed / passed / failed — so this is expected to FAIL. Confirming it is what matters.');

  // Build a fresh enrollable course (module 7797139 is the type this portal accepts), enroll on it.
  const created = await api('POST', 'courses', {
    Course: { name: 'MCPDEMO Progress Probe', owner_id: 32088202, reference_code: 'MCPDEMO-PROGRESS' }
  }, { quiet: true });
  const courseId = created.json && created.json.id;
  record('courses', courseId);
  await api('POST', 'courses/add_module', { course_id: courseId, module_id: 7797139 }, { quiet: true });
  await api('POST', 'courses/publish', { course_id: courseId }, { quiet: true });
  const r = await api('POST', 'enrollments',
    { Enrollment: { email: SPIKE_EMAIL, course_id: courseId, due_date: daysAgo(5) } }, { quiet: true });
  const id = r.json && r.json.id;
  if (id) record('enrollments', id);
  if (!id) { console.log('    could not create an enrollment to experiment on'); return; }
  console.log('    experimenting on enrollment ' + id + ' (course ' + courseId + ')');

  const attempts = [
    ['status: in_progress + percentage 30', { Markcomplete: { enrollment_id: id, status: 'in_progress', percentage: 30, date_completed: daysAgo(22) + 'T12:00:00Z' } }],
    ['status: started', { Markcomplete: { enrollment_id: id, status: 'started', percentage: 30, date_completed: daysAgo(22) + 'T12:00:00Z' } }],
    ['numeric status 2', { Markcomplete: { enrollment_id: id, status: 2, percentage: 30, date_completed: daysAgo(22) + 'T12:00:00Z' } }],
    ['percentage only, no status', { Markcomplete: { enrollment_id: id, percentage: 30, date_completed: daysAgo(22) + 'T12:00:00Z' } }],
    ['PATCH the enrollment directly', null]
  ];

  for (const [label, payload] of attempts) {
    console.log('\n  Attempt: ' + label);
    if (payload) await api('POST', 'markcompletes', payload, { limit: 400 });
    else await api('PATCH', 'enrollments/' + id,
      { Enrollment: { percentage: 30, status: 'in_progress' } }, { limit: 400 });

    const back = await api('GET', 'enrollments/' + id, null, { quiet: true });
    const e = back.json && (back.json.enrollment || back.json.enrollments && back.json.enrollments[0] || back.json);
    console.log('    -> status=' + (e && (e.status || e.status_id)) +
      '  percentage=' + (e && e.percentage) +
      '  date_completed=' + (e && e.date_completed) +
      '  date_last_accessed=' + (e && (e.date_last_accessed || e.date_lastaccessed)));
  }
}

// ---------------------------------------------------------------------------
// Spike 3 — delete a completed enrollment
// ---------------------------------------------------------------------------

async function spikeDelete() {
  header('SPIKE 3 — can a Completed enrollment be deleted? This is the refresh path.',
    'Docs give DELETE /enrollments/{id} an optional remove_from_history flag that force-deletes\n' +
    'learning history including completed enrollments.');

  const md = manifest().enrollments;
  const id = process.argv[3] || md[md.length - 1];
  if (!id) { console.log('    Run `enroll` and `complete` first.'); return; }
  console.log('    using enrollment ' + id);

  console.log('\n1. Plain delete of a COMPLETED enrollment');
  const plain = await api('DELETE', 'enrollments/' + id, null, { limit: 400 });

  let gone = await enrollmentGone(id);
  console.log('    -> ' + (gone ? 'DELETED' : 'still present'));

  if (!gone) {
    console.log('\n2. Retry with remove_from_history=true');
    await api('DELETE', 'enrollments/' + id + '?remove_from_history=true', null, { limit: 400 });
    gone = await enrollmentGone(id);
    console.log('    -> ' + (gone ? 'DELETED with remove_from_history' : 'STILL PRESENT'));
  }
  if (gone) unrecord('enrollments', id);

  console.log('\n    VERDICT: refresh can ' + (gone ? 'delete and recreate enrollments.' :
    'NOT delete completed enrollments — fall back to deleting and re-cloning the course.'));
}

async function enrollmentGone(id) {
  const r = await api('GET', 'enrollments/' + id, null, { quiet: true });
  if (r.status === 404) return true;
  const e = r.json && (r.json.enrollment || (r.json.enrollments && r.json.enrollments[0]));
  return !e;
}

// ---------------------------------------------------------------------------

async function report() {
  header('Everything this script created');
  const m = manifest();
  console.log(JSON.stringify(m, null, 2));
  for (const id of m.courses) {
    const c = await getCourse(id);
    console.log('    course ' + id + ': ' + (c ? '"' + c.name + '" modules=' + c.number_of_modules +
      ' ref=' + c.reference_code + ' published=' + (c.date_published ? c.date_published.slice(0, 10) : 'NO') : 'NOT FOUND'));
  }
  if (m.users[0]) {
    console.log('\n  Enrollments for the spike user:');
    await api('GET', 'enrollments/search?user_id=' + m.users[0], null, { limit: 2500 });
  }
}

async function cleanup() {
  header('CLEANUP — deletes only what is in the spike manifest');
  const m = manifest();
  for (const id of m.enrollments.slice()) {
    const r = await api('DELETE', 'enrollments/' + id + '?remove_from_history=true', null, { show: false });
    console.log('    enrollment ' + id + ': HTTP ' + r.status);
    if (r.status < 400 || r.status === 404) unrecord('enrollments', id);
  }
  for (const id of m.courses.slice()) {
    const r = await api('DELETE', 'courses/' + id, null, { show: false });
    console.log('    course ' + id + ': HTTP ' + r.status +
      (r.status >= 400 ? '  (a course must be in DRAFT state to delete)' : ''));
    if (r.status < 400 || r.status === 404) unrecord('courses', id);
  }
  console.log('\n    Users are never deleted by this script. Remaining: ' +
    JSON.stringify(manifest().users) + '  — remove in the UI if you want it gone.');
}

/** Set the guid by hand, or clone one published course, from the command line. */
async function setGuid() {
  const m = manifest();
  m.guid = process.argv[3];
  save(m);
  console.log('    guid = ' + m.guid);
}

async function cloneOneCmd() {
  header('Clone one course, published, then rename it');
  await cloneOne(process.argv[3] || 'Getting Started with ACME',
    process.argv[4] || 'MCPDEMO-NCE-GETTING-STARTED');
}

/** Debug: PUT a course and show exactly what comes back. */
async function renameCmd() {
  const id = process.argv[3];
  header('PUT /courses/' + id + ' — rename and tag');
  await api('PUT', 'courses/' + id, {
    Course: {
      name: process.argv[4] || 'Getting Started with ACME',
      reference_code: process.argv[5] || 'MCPDEMO-NCE-GETTING-STARTED'
    }
  }, { limit: 1200 });
  const c = await getCourse(id);
  console.log('\n    after: name="' + (c && c.name) + '"  reference_code=' + (c && c.reference_code));
}

/** Are draft courses visible anywhere? The first clone went to draft and never showed up. */
async function draftsCmd() {
  header('Can we see DRAFT courses at all?');
  const base = (await courseIds()).length;
  console.log('    GET /courses                     -> ' + base + ' courses');
  for (const q of ['courses?status=draft', 'courses?course_status=draft', 'courses?published=false',
                   'courses?include_drafts=true', 'courses?status=1', 'courses?state=draft']) {
    const r = await api('GET', q, null, { quiet: true });
    const n = ((r.json && r.json.courses) || []).length;
    console.log('    GET /' + (q + '                              ').slice(0, 32) + ' -> ' + n +
      ' courses' + (n !== base ? '   <-- DIFFERENT' : ''));
  }
}

/**
 * SPIKE 4b — build a course directly instead of cloning it.
 *
 * Cloning cannot give us the titles the demo needs: the clone is named "<source> - Copy" and every
 * nested course path (PUT /courses/{id}) 404s on this portal, so there is no rename. Creating the
 * course outright gives an exact name AND reference_code in one call, then we attach the source
 * course's modules for real content.
 */
async function buildCourse() {
  header('SPIKE 4b — POST /courses with an exact name + reference_code, then attach modules',
    'Payload is wrapped in a "Course" object, per the docs.');

  console.log('\n1. What modules does source course ' + SOURCE_COURSE + ' have?');
  const mods = await api('GET', 'modules?course_id=' + SOURCE_COURSE, null, { quiet: true });
  const moduleList = (mods.json && (mods.json.modules || mods.json.module)) || [];
  console.log('    ' + moduleList.length + ' module(s): ' +
    moduleList.map(m => m.id + ' (' + (m.name || m.title) + ')').join(', ').slice(0, 400));

  const ownerId = Number(process.argv[3] || 32088202);
  console.log('\n2. Create the course, owner_id ' + ownerId);
  const created = await api('POST', 'courses', {
    Course: {
      name: 'Getting Started with ACME',
      owner_id: ownerId,
      reference_code: 'MCPDEMO-NCE-GETTING-STARTED',
      description: 'Required onboarding training for new ACME customers.'
    }
  }, { limit: 600 });
  const id = created.json && (created.json.id || (created.json.course && created.json.course.id));
  if (!id) { console.log('    no course id returned — stopping'); return; }
  record('courses', id);

  console.log('\n3. Attach the source modules (target must be in draft, which a new course is)');
  for (const mod of moduleList.slice(0, 3)) {
    const r = await api('POST', 'courses/add_module', { course_id: id, module_id: mod.id }, { quiet: true });
    console.log('    module ' + mod.id + ' -> HTTP ' + r.status +
      (r.status >= 400 ? '  ' + String(r.text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120) : ''));
  }

  console.log('\n4. Publish');
  await api('POST', 'courses/publish', { course_id: id }, { limit: 300 });

  const c = await getCourse(id);
  console.log('\n    RESULT: id=' + id + '  name="' + (c && c.name) + '"');
  console.log('            reference_code=' + (c && c.reference_code) +
    '  modules=' + (c && c.number_of_modules) +
    '  published=' + (c && c.date_published ? c.date_published.slice(0, 10) : 'NO'));
}

/** Is "course capacity reached" caused by the course, or by a module we attached? */
async function bareCourse() {
  header('Isolating "course capacity reached" — a course with NO modules');
  const created = await api('POST', 'courses', {
    Course: { name: 'MCPDEMO Bare Probe', owner_id: 32088202, reference_code: 'MCPDEMO-BARE' }
  }, { quiet: true });
  const id = created.json && created.json.id;
  if (!id) { console.log('    create failed'); return; }
  record('courses', id);
  console.log('    created bare course ' + id);

  await api('POST', 'courses/publish', { course_id: id }, { quiet: true });
  const r = await api('POST', 'enrollments',
    { Enrollment: { email: SPIKE_EMAIL, course_id: id, due_date: daysAgo(18) } }, { limit: 300 });
  const eid = r.json && r.json.id;
  if (eid) record('enrollments', eid);
  console.log('\n    VERDICT: enrolling on a module-less API-created course ' +
    (r.status < 400 ? 'WORKS -> the modules were the problem' :
                      'FAILS TOO -> it is the course, not the modules'));
}

/** Build a course with one named module and try to enroll — which module types are enrollable? */
async function buildWith() {
  const moduleId = process.argv[3];
  header('Course with module ' + moduleId + ' only');
  const created = await api('POST', 'courses', {
    Course: { name: 'MCPDEMO Probe ' + moduleId, owner_id: 32088202,
              reference_code: 'MCPDEMO-PROBE-' + moduleId }
  }, { quiet: true });
  const id = created.json && created.json.id;
  if (!id) { console.log('    create failed'); return; }
  record('courses', id);

  const add = await api('POST', 'courses/add_module', { course_id: id, module_id: moduleId }, { quiet: true });
  console.log('    add_module -> HTTP ' + add.status);
  await api('POST', 'courses/publish', { course_id: id }, { quiet: true });

  const r = await api('POST', 'enrollments',
    { Enrollment: { email: SPIKE_EMAIL, course_id: id, due_date: daysAgo(18) } }, { limit: 250 });
  const eid = r.json && r.json.id;
  if (eid) record('enrollments', eid);
  console.log('    ENROLL -> ' + (r.status < 400 ? 'OK, enrollment ' + eid : 'FAILED'));
}

/** Does remove_from_history belong in the BODY rather than the query string? */
async function deleteBody() {
  const id = process.argv[3];
  header('DELETE /enrollments/' + id + ' with remove_from_history in the body');
  const before = await api('GET', 'enrollments/' + id, null, { quiet: true });
  const e0 = before.json && before.json.enrollments && before.json.enrollments[0];
  console.log('    before: status=' + (e0 && e0.status) + ' date_completed=' + (e0 && e0.date_completed));

  for (const body of [{ Enrollment: { remove_from_history: true } }, { remove_from_history: true }]) {
    console.log('\n    body ' + JSON.stringify(body));
    const r = await api('DELETE', 'enrollments/' + id, body, { limit: 300 });
    const after = await api('GET', 'enrollments/' + id, null, { quiet: true });
    const list = (after.json && after.json.enrollments) || [];
    const still = list.filter(x => String(x.id) === String(id))[0];
    console.log('    -> ' + (still ? 'STILL PRESENT (status=' + still.status + ')' : 'DELETED'));
    if (!still) { unrecord('enrollments', id); break; }
  }
}

/**
 * The two operations the refresh design rests on:
 *   safe path    — PATCH the due date forward
 *   rebuild path — delete the enrollment and recreate it
 */
async function refreshTest() {
  const id = process.argv[3];
  header('Refresh primitives on enrollment ' + id);

  const before = await api('GET', 'enrollments/' + id, null, { quiet: true });
  const e0 = (before.json && before.json.enrollments || []).filter(x => String(x.id) === String(id))[0];
  console.log('    before: status=' + (e0 && e0.status) + '  due_date=' + (e0 && e0.due_date));

  const target = ymd(new Date(Date.now() + 21 * 86400000));
  console.log('\n1. PATCH the due date forward to ' + target);
  for (const body of [{ Enrollment: { due_date: target } }, { due_date: target }]) {
    const r = await api('PATCH', 'enrollments/' + id, body, { limit: 250 });
    const after = await api('GET', 'enrollments/' + id, null, { quiet: true });
    const e = (after.json && after.json.enrollments || []).filter(x => String(x.id) === String(id))[0];
    const moved = e && String(e.due_date || '').slice(0, 10) === target;
    console.log('    body ' + JSON.stringify(body) + ' -> due_date now ' + (e && e.due_date) +
      (moved ? '   MOVED' : '   unchanged'));
    if (moved) break;
  }

  console.log('\n2. Delete this enrollment (status ' + (e0 && e0.status) + ')');
  const d = await api('DELETE', 'enrollments/' + id, null, { limit: 250 });
  const after = await api('GET', 'enrollments/' + id, null, { quiet: true });
  const still = (after.json && after.json.enrollments || []).filter(x => String(x.id) === String(id))[0];
  console.log('    -> ' + (still ? 'STILL PRESENT' : 'DELETED'));
  if (!still) unrecord('enrollments', id);
}

/**
 * Can a COMPLETED enrollment be deleted after all? Spike 3 said no, but it only ever sent the
 * boolean true. Michael deleted one from ACME using the STRING "true". Test every variant on a
 * freshly created completion so the answer is unambiguous.
 */
async function deleteCompletedTest() {
  header('Re-testing spike 3 — remove_from_history variants on a COMPLETED enrollment');

  const variants = [
    ['body, string "true"',   { body: { remove_from_history: 'true' } }],
    ['body, boolean true',    { body: { remove_from_history: true } }],
    ['body, wrapped string',  { body: { Enrollment: { remove_from_history: 'true' } } }],
    ['query string ?remove_from_history=true', { query: '?remove_from_history=true' }],
    ['no body at all',        {}]
  ];

  for (const [label, variant] of variants) {
    // Fresh course + enrollment + completion for each variant, so no test contaminates the next.
    const c = await api('POST', 'courses', { Course: {
      name: 'MCPDEMO Delete Probe ' + label.replace(/[^a-z0-9 ]/gi, ''),
      owner_id: 32088202, reference_code: 'MCPDEMO-DELPROBE'
    } }, { quiet: true });
    const courseId = c.json && c.json.id;
    if (!courseId) { console.log('  ' + label + ': could not create a course'); continue; }
    record('courses', courseId);
    await api('POST', 'courses/add_module', { course_id: courseId, module_id: 7788730 }, { quiet: true });
    await api('POST', 'courses/publish', { course_id: courseId }, { quiet: true });

    const e = await api('POST', 'enrollments',
      { Enrollment: { email: SPIKE_EMAIL, course_id: courseId, due_date: daysAgo(10) } }, { quiet: true });
    const eid = e.json && e.json.id;
    if (!eid) { console.log('  ' + label + ': could not enroll'); continue; }

    const mc = await api('POST', 'markcompletes', { Markcomplete: {
      enrollment_id: eid, date_completed: daysAgo(20) + 'T12:00:00Z', status: 'completed'
    } }, { quiet: true });

    const pre = await api('GET', 'enrollments/' + eid, null, { quiet: true });
    const preStatus = ((pre.json && pre.json.enrollments) || [{}])[0].status;

    const del = await api('DELETE', 'enrollments/' + eid + (variant.query || ''),
      variant.body || null, { quiet: true });

    const post = await api('GET', 'enrollments/' + eid, null, { quiet: true });
    const still = ((post.json && post.json.enrollments) || []).filter(x => String(x.id) === String(eid))[0];

    console.log('  ' + (label + '                                        ').slice(0, 42) +
      'status before=' + preStatus + '  DELETE HTTP ' + del.status +
      '  ->  ' + (still ? 'STILL PRESENT' : '*** DELETED ***'));
    if (!still) unrecord('enrollments', eid);
    else record('enrollments', eid);
  }
}

const commands = {
  deletecompleted: deleteCompletedTest, refresh: refreshTest, deletebody: deleteBody, buildwith: buildWith, bare: bareCourse, setguid: setGuid, cloneone: cloneOneCmd, rename: renameCmd, drafts: draftsCmd, build: buildCourse,
  clone: spikeClone, user: spikeUser, enroll: spikeEnroll, complete: spikeComplete,
  progress: spikeProgress, delete: spikeDelete, report: report, cleanup: cleanup
};

(async () => {
  const cmd = process.argv[2];
  if (!commands[cmd]) { console.log('Commands: ' + Object.keys(commands).join(', ')); process.exit(1); }
  console.log('Portal: ' + env.LEARNUPON_PORTAL_SUBDOMAIN + '.learnupon.com  (credentials not shown)');
  await commands[cmd]();
})();
