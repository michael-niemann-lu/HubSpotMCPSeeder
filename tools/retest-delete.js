#!/usr/bin/env node
/**
 * retest-delete.js — re-tests spike 3 against the seeded ACME data, and proves the rebuild cycle.
 *
 * Spike 3 concluded a completed enrollment cannot be deleted. It only ever sent the BOOLEAN true.
 * Michael deleted one from ACME using the STRING "true". This finds out which variant works, on a
 * real seeded completion, and then puts the completion back exactly as it was.
 *
 * Deliberately picks a user from the LARGEST established account, so that if restore fails the
 * percentage damage is smallest, and reports precisely what state it left behind.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', 'apps-script', 'local', '.env');
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

let last = 0;
async function api(method, p, body) {
  const wait = 250 - (Date.now() - last);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
  const headers = { Authorization: AUTH, Accept: 'application/json' };
  const init = { method: method, headers: headers };
  if (body) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(BASE + p, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* html */ }
  return { status: res.status, json: json, text: text };
}

const first = (b, k) => (b && (b[k] || [])) || [];

(async () => {
  console.log('Portal: ' + env.LEARNUPON_PORTAL_SUBDOMAIN + '.learnupon.com\n');

  // Our seeded courses, by tag.
  const courses = first((await api('GET', 'courses')).json, 'courses')
    .filter(c => String(c.reference_code || '').startsWith('MCPDEMO-'));
  const gs = courses.filter(c => c.reference_code === 'MCPDEMO-NCE-GETTING-STARTED')[0];
  if (!gs) { console.log('Could not find MCPDEMO-NCE-GETTING-STARTED'); return; }
  console.log('Course: ' + gs.id + '  "' + gs.name + '"');

  // A completed enrollment at the largest established account, so a failed restore costs least.
  const rows = first((await api('GET', 'enrollments/search?course_id=' + gs.id)).json, 'enrollments')
    .filter(e => String(e.course_id) === String(gs.id));
  const victim = rows.filter(e =>
    String(e.status) === 'completed' && /northwindlogistics\.com$/.test(String(e.email || '')))[0];
  if (!victim) { console.log('No completed northwind enrollment found'); return; }

  console.log('Test subject: enrollment ' + victim.id + '  ' + victim.email);
  console.log('  status=' + victim.status + '  date_completed=' + victim.date_completed +
    '  due_date=' + victim.due_date + '  user_id=' + victim.user_id + '\n');

  const original = {
    email: victim.email, user_id: victim.user_id, course_id: gs.id,
    date_completed: String(victim.date_completed || ''),
    due_date: String(victim.due_date || '').slice(0, 10)
  };

  const gone = async id => {
    const r = await api('GET', 'enrollments/' + id);
    if (r.status === 404) return true;
    return !first(r.json, 'enrollments').filter(e => String(e.id) === String(id))[0];
  };

  // --- the variants, most-likely first --------------------------------------
  const variants = [
    ['body {"remove_from_history":"true"}  (string)', { remove_from_history: 'true' }],
    ['body {"remove_from_history":true}    (boolean)', { remove_from_history: true }]
  ];

  let deleted = false, winner = null;
  for (const [label, body] of variants) {
    const r = await api('DELETE', 'enrollments/' + victim.id, body);
    const isGone = await gone(victim.id);
    console.log('  ' + (label + '                                          ').slice(0, 48) +
      'HTTP ' + r.status + '  ->  ' + (isGone ? '*** DELETED ***' : 'still present') +
      (r.status >= 400 ? '   ' + String(r.text).replace(/\s+/g, ' ').slice(0, 90) : ''));
    if (isGone) { deleted = true; winner = label; break; }
  }

  if (!deleted) {
    console.log('\nVERDICT: spike 3 stands — completed enrollments cannot be deleted.');
    console.log('Nothing was changed. The enrollment is intact.');
    return;
  }

  console.log('\nVERDICT: SPIKE 3 WAS WRONG. Completed enrollments CAN be deleted, via');
  console.log('         ' + winner);

  // --- restore it, which is exactly the refresh rebuild cycle ---------------
  console.log('\nRestoring — re-enroll, then re-complete at the original date:');
  const re = await api('POST', 'enrollments', { Enrollment: {
    email: original.email, course_id: original.course_id, due_date: original.due_date
  } });
  const newId = re.json && re.json.id;
  console.log('  re-enrolled -> HTTP ' + re.status + '  enrollment ' + newId);
  if (!newId) {
    console.log('  *** RESTORE FAILED — one completion is missing from ' + original.email);
    console.log('  Fix: Developer -> Repair Manifest, then Seed -> 4. Completions');
    return;
  }

  const mc = await api('POST', 'markcompletes', { Markcomplete: {
    enrollment_id: newId, date_completed: original.date_completed, status: 'completed'
  } });
  console.log('  re-completed -> HTTP ' + mc.status);

  const check = first((await api('GET', 'enrollments/' + newId)).json, 'enrollments')[0] || {};
  console.log('  now: status=' + check.status + '  date_completed=' + check.date_completed);
  console.log('  original:    status=completed  date_completed=' + original.date_completed);
  console.log('\n  ' + (String(check.status) === 'completed' &&
    String(check.date_completed).slice(0, 10) === original.date_completed.slice(0, 10)
      ? 'RESTORED EXACTLY — the rebuild cycle works end to end.'
      : 'RESTORE IMPERFECT — compare the two lines above.'));
  console.log('\n  NOTE: enrollment id changed ' + victim.id + ' -> ' + newId +
    '. _Manifest still holds the old id, so run Developer -> Repair Manifest.');
})();
