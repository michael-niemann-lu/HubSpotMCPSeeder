#!/usr/bin/env node
/**
 * hubspot-spike.js — resolves the HubSpot unknowns the data model depends on.
 *
 * Writes ONLY tickets and deals, which are disposable in our class model, and archives everything it
 * creates before it exits. It never touches contacts or companies, and never uses the GDPR delete
 * endpoint — archive is recoverable for ~90 days, permanent deletion is not.
 *
 * The question that matters: is `createdate` settable on a ticket? Story 3 needs Alderfield's 11
 * tickets dated during its onboarding, and scenario 2's whole before/after deflection story is dated
 * ticket volume. If it is not settable, the model switches to a custom reported_date property — a
 * one-line change now, a refactor later.
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
const TOKEN = loadEnv().HUBSPOT_TOKEN;
const BASE = 'https://api.hubapi.com';
// NOTE: this is the OWNER id, not the user id. HubSpot gives a person both, and
// hubspot_owner_id rejects the user id with INVALID_OWNER_ID. Michael: userId 48285255,
// ownerId 268202805.
const OWNER_ID = process.argv[2] || '268202805';

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method: method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* empty 204 */ }
  return { status: res.status, body: json, text: text };
}

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const created = { tickets: [], deals: [] };

(async () => {
  console.log('HubSpot spikes — portal 23399533. Tickets and deals only; archived at the end.\n');

  // --- 0. Does the owner exist? --------------------------------------------
  const owner = await api('GET', '/crm/v3/owners/' + OWNER_ID);
  console.log('OWNER ' + OWNER_ID + ': HTTP ' + owner.status +
    (owner.status === 200
      ? '  ' + owner.body.email + '  (' + [owner.body.firstName, owner.body.lastName].filter(Boolean).join(' ') + ')'
      : '  ' + owner.text.slice(0, 160)));

  // --- 1. Ticket createdate on CREATE --------------------------------------
  console.log('\nSPIKE A — is ticket createdate settable on create?');
  const wanted = daysAgo(120);
  const t = await api('POST', '/crm/v3/objects/tickets', {
    properties: {
      subject: '[MCP-SPIKE] createdate probe',
      hs_pipeline: '0', hs_pipeline_stage: '1', hs_ticket_priority: 'MEDIUM',
      createdate: wanted + 'T12:00:00Z'
    }
  });
  if (t.status >= 400) {
    console.log('  create FAILED: HTTP ' + t.status + '  ' + t.text.slice(0, 300));
  } else {
    created.tickets.push(t.body.id);
    const got = String(t.body.properties.createdate || '').slice(0, 10);
    console.log('  asked for createdate ' + wanted);
    console.log('  got               ' + got);
    console.log('  VERDICT: ' + (got === wanted
      ? 'SETTABLE on create — ticket dates can be backdated directly'
      : 'NOT settable on create — it silently used today'));

    // --- 2. Ticket createdate on UPDATE ------------------------------------
    console.log('\nSPIKE B — is it settable on update?');
    const upd = await api('PATCH', '/crm/v3/objects/tickets/' + t.body.id, {
      properties: { createdate: daysAgo(200) + 'T12:00:00Z' }
    });
    if (upd.status >= 400) {
      console.log('  PATCH rejected: HTTP ' + upd.status + '  ' + upd.text.slice(0, 220));
      console.log('  VERDICT: read-only after creation');
    } else {
      const after = String(upd.body.properties.createdate || '').slice(0, 10);
      console.log('  asked for ' + daysAgo(200) + ', got ' + after);
      console.log('  VERDICT: ' + (after === daysAgo(200) ? 'settable on update too' : 'ignored on update'));
    }
  }

  // --- 3. Deal closedate + createdate --------------------------------------
  console.log('\nSPIKE C — deal closedate and createdate, for the established cohort');
  const d = await api('POST', '/crm/v3/objects/deals', {
    properties: {
      dealname: '[MCP-SPIKE] backdate probe', pipeline: 'default', dealstage: 'closedwon',
      amount: '1000', closedate: daysAgo(300) + 'T12:00:00Z', createdate: daysAgo(330) + 'T12:00:00Z',
      hubspot_owner_id: OWNER_ID
    }
  });
  if (d.status >= 400) {
    console.log('  create FAILED: HTTP ' + d.status + '  ' + d.text.slice(0, 300));
  } else {
    created.deals.push(d.body.id);
    const close = String(d.body.properties.closedate || '').slice(0, 10);
    const make = String(d.body.properties.createdate || '').slice(0, 10);
    console.log('  closedate  asked ' + daysAgo(300) + '  got ' + close +
      '   ' + (close === daysAgo(300) ? 'SETTABLE' : 'ignored'));
    console.log('  createdate asked ' + daysAgo(330) + '  got ' + make +
      '   ' + (make === daysAgo(330) ? 'SETTABLE' : 'ignored'));
    console.log('  owner assignment: ' + (d.body.properties.hubspot_owner_id === OWNER_ID ? 'OK' : 'not applied'));
  }

  // --- 4. Cleanup ----------------------------------------------------------
  console.log('\nCLEANUP — archiving everything this spike created');
  for (const [type, ids] of Object.entries(created)) {
    for (const id of ids) {
      const r = await api('DELETE', '/crm/v3/objects/' + type + '/' + id);
      console.log('  archive ' + type + '/' + id + ' -> HTTP ' + r.status +
        (r.status === 204 ? '  (recoverable for ~90 days)' : ''));
    }
  }
})();
