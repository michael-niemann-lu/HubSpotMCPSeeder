#!/usr/bin/env node
/**
 * probe-api.js — diagnostic harness for the LearnUpon REST API.
 *
 * Reads credentials from apps-script/local/.env and prints ONLY status codes and response bodies.
 * Credentials are never printed, logged or echoed. Read-only: GET requests unless --allow-write is
 * passed, which nothing currently uses.
 *
 *   node tools/probe-api.js                    run the standard diagnostic set
 *   node tools/probe-api.js courses/5128555    GET one path
 */

'use strict';
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', 'apps-script', 'local', '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error('No .env at ' + ENV_PATH);
    process.exit(1);
  }
  const env = {};
  fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const i = t.indexOf('=');
    if (i === -1) return;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[t.slice(0, i).trim()] = v;
  });
  return env;
}

const env = loadEnv();
const SUB = env.LEARNUPON_PORTAL_SUBDOMAIN;
const USER = env.LEARNUPON_PORTAL_API_USERNAME;
const PASS = env.LEARNUPON_PORTAL_API_PASSWORD;

if (!SUB || !USER || !PASS) {
  console.error('Missing one of LEARNUPON_PORTAL_SUBDOMAIN / _API_USERNAME / _API_PASSWORD');
  process.exit(1);
}

const BASE = 'https://' + SUB + '.learnupon.com/api/v1/';
const AUTH = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');

async function call(label, urlPath, extraHeaders, method, body) {
  const headers = Object.assign({ Authorization: AUTH, Accept: 'application/json' }, extraHeaders || {});
  const opts = { method: method || 'GET', headers: headers };
  if (body) opts.body = JSON.stringify(body);

  let res, text;
  try {
    res = await fetch(BASE + urlPath, opts);
    text = await res.text();
  } catch (e) {
    console.log('\n--- ' + label);
    console.log('    ' + (method || 'GET') + ' /' + urlPath);
    console.log('    NETWORK ERROR: ' + e.message);
    return null;
  }

  const rateHeaders = [];
  res.headers.forEach((v, k) => {
    if (k.toLowerCase().indexOf('rate') !== -1 || k.toLowerCase().indexOf('lu-') === 0) {
      rateHeaders.push(k + ': ' + v);
    }
  });

  console.log('\n--- ' + label);
  console.log('    ' + (method || 'GET') + ' /' + urlPath +
    (extraHeaders ? '   headers: ' + JSON.stringify(Object.keys(extraHeaders)) : ''));
  console.log('    HTTP ' + res.status);
  if (rateHeaders.length) console.log('    ' + rateHeaders.join('\n    '));

  let out = text;
  try { out = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* not json */ }
  if (out.length > 1200) out = out.slice(0, 1200) + '\n    ... truncated';
  console.log('    ' + out.split('\n').join('\n    '));
  return { status: res.status, text: text };
}

(async () => {
  console.log('Portal: ' + SUB + '.learnupon.com   (credentials loaded, not shown)');

  const arg = process.argv[2];

  // Compact course inventory — for choosing a clone source.
  if (arg === 'courses') {
    const res = await fetch(BASE + 'courses', { headers: { Authorization: AUTH, Accept: 'application/json' } });
    const body = JSON.parse(await res.text());
    const courses = body.courses || [];
    console.log('\n' + courses.length + ' courses\n');
    console.log('  id        modules  enrolled  published            name');
    courses
      .sort((a, b) => (b.number_of_modules - a.number_of_modules) || (b.num_enrolled - a.num_enrolled))
      .forEach(c => {
        console.log('  ' + String(c.id).padEnd(10) +
          String(c.number_of_modules === null ? '?' : c.number_of_modules).padEnd(9) +
          String(c.num_enrolled).padEnd(10) +
          String(c.date_published ? c.date_published.slice(0, 10) : 'NOT PUBLISHED').padEnd(21) +
          c.name);
      });
    return;
  }

  // Does a query parameter actually filter, or is it silently ignored?
  if (arg === 'filtercheck') {
    const get = async p => {
      const res = await fetch(BASE + p, { headers: { Authorization: AUTH, Accept: 'application/json' } });
      const body = JSON.parse(await res.text());
      const list = body.courses || [];
      return { n: list.length, ids: list.slice(0, 3).map(c => c.id) };
    };
    for (const p of ['courses', 'courses?id=5128555', 'courses?course_id=5128555',
                     'courses?reference_code=NOPE-DOES-NOT-EXIST']) {
      const r = await get(p);
      console.log('  ' + p.padEnd(46) + r.n + ' course(s)   first ids: ' + r.ids.join(', '));
    }
    return;
  }

  // Field-by-field diff of two course records — why does one accept enrollments and the other not?
  if (arg === 'diffcourse') {
    const get = async id => {
      const res = await fetch(BASE + 'courses?course_id=' + id,
        { headers: { Authorization: AUTH, Accept: 'application/json' } });
      const body = JSON.parse(await res.text());
      return (body.courses || []).filter(c => String(c.id) === String(id))[0] || {};
    };
    const a = await get(process.argv[3]);
    const b = await get(process.argv[4]);
    const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).sort();
    console.log('\n  ' + 'field'.padEnd(34) + String(process.argv[3]).padEnd(24) + process.argv[4]);
    keys.forEach(k => {
      const va = JSON.stringify(a[k]), vb = JSON.stringify(b[k]);
      if (va !== vb) console.log('  ' + k.padEnd(34) + String(va).slice(0, 22).padEnd(24) + String(vb).slice(0, 40));
    });
    return;
  }

  // Module inventory for a course — component_type decides whether a course built from it
  // can be enrolled on at all.
  if (arg === 'modules') {
    const res = await fetch(BASE + 'modules?course_id=' + (process.argv[3] || '5128555'),
      { headers: { Authorization: AUTH, Accept: 'application/json' } });
    const body = JSON.parse(await res.text());
    const mods = body.modules || body.module || [];
    console.log('\n  ' + mods.length + ' module(s)\n');
    console.log('  id           component_type        name');
    mods.forEach(m => console.log('  ' + String(m.id).padEnd(13) +
      String(m.component_type || '?').padEnd(22) + (m.name || m.title || '')));
    return;
  }

  // Ground truth: what does the portal actually hold for our tagged courses?
  if (arg === 'audit') {
    const get = async p => {
      const res = await fetch(BASE + p, { headers: { Authorization: AUTH, Accept: 'application/json' } });
      return JSON.parse(await res.text());
    };
    const courses = ((await get('courses')).courses || [])
      .filter(c => String(c.reference_code || '').startsWith('MCPDEMO-'));
    console.log('\n  ' + courses.length + ' MCPDEMO course(s). Counting via enrollments/search —');
    console.log('  the num_* counters on the course record are stale and cannot be trusted.\n');
    console.log('  id        total  not_started  in_progress  completed  overdue  name');
    const tot = { n: 0, ns: 0, ip: 0, c: 0, od: 0 };
    for (const c of courses) {
      const body = await get('enrollments/search?course_id=' + c.id);
      const rows = (body.enrollments || []).filter(e => String(e.course_id) === String(c.id));
      const by = k => rows.filter(e => String(e.status) === k).length;
      const overdue = rows.filter(e => e.due_date && String(e.status) !== 'completed' &&
        new Date(e.due_date) < new Date()).length;
      console.log('  ' + String(c.id).padEnd(10) + String(rows.length).padEnd(7) +
        String(by('not_started')).padEnd(13) + String(by('in_progress')).padEnd(13) +
        String(by('completed')).padEnd(11) + String(overdue).padEnd(9) + c.name);
      tot.n += rows.length; tot.ns += by('not_started'); tot.ip += by('in_progress');
      tot.c += by('completed'); tot.od += overdue;
    }
    console.log('\n  TOTAL  ' + tot.n + ' enrollments: ' + tot.ns + ' not started, ' +
      tot.ip + ' in progress, ' + tot.c + ' completed, ' + tot.od + ' overdue');
    console.log('  PLAN   223 enrollments: 28 not started, 3 in progress, 192 completed, 24 overdue');
    return;
  }

  if (arg) {
    await call('ad-hoc', arg.replace(/^\/+/, ''));
    return;
  }

  // 1. The call we know works, as a control.
  await call('control: users list', 'users?limit=1');

  // 2. The failing call, exactly as the Apps Script client used to send it.
  await call('courses/{id} WITH Content-Type (the suspected bug)', 'courses/5128555',
    { 'Content-Type': 'application/json' });

  // 3. The same call without the content type — the fix.
  await call('courses/{id} without Content-Type', 'courses/5128555');

  // 4. Is the id even valid in this portal?
  await call('courses list', 'courses?limit=3');

  // 5. Custom user data definitions.
  await call('custom user data definitions', 'users/customuserdata');
})();
