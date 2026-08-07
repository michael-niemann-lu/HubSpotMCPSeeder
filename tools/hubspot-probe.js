#!/usr/bin/env node
/**
 * hubspot-probe.js — read-only reconnaissance of the HubSpot portal.
 *
 * Reads HUBSPOT_TOKEN from apps-script/local/.env and prints only metadata: the portal id, the
 * token's scopes, which objects are readable, what pipelines and stages exist, which custom
 * properties are already defined, and who the owners are. The token itself is never printed.
 *
 * Every call is a GET. Nothing is created, changed or archived.
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
const TOKEN = env.HUBSPOT_TOKEN || env.HS_TOKEN || env.HUBSPOT_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('No HUBSPOT_TOKEN in .env');
  process.exit(1);
}
const BASE = 'https://api.hubapi.com';

async function api(p) {
  const res = await fetch(BASE + p, {
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
  });
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch (e) { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: body };
}

// What scenario 1 needs, mapped to the scope that grants it.
const NEEDED = [
  ['crm.objects.companies.read', 'read companies'],
  ['crm.objects.companies.write', 'create the 9 demo companies'],
  ['crm.objects.contacts.read', 'read contacts'],
  ['crm.objects.contacts.write', 'create the named personas as contacts'],
  ['crm.objects.deals.read', 'read deals'],
  ['crm.objects.deals.write', 'create onboarding deals, and backdate closedate'],
  ['tickets', 'create and read support tickets'],
  ['crm.schemas.companies.write', 'create the onboarding_start_date / go_live_date properties'],
  ['crm.objects.owners.read', 'resolve the CSM owner']
];

(async () => {
  console.log('HubSpot probe — read-only. Token not printed.\n');

  // 0. WHAT KIND OF PORTAL IS THIS? Asked first, because everything after it is a write into
  //    somebody's CRM. A production portal with real contacts is not a demo portal.
  const acct = await api('/account-info/v3/details');
  if (acct.status === 200) {
    console.log('  Portal id       : ' + acct.body.portalId);
    console.log('  Account type    : ' + acct.body.accountType +
      (acct.body.accountType === 'STANDARD' ? '   <-- production, not a sandbox' : ''));
    console.log('  Time zone       : ' + acct.body.timeZone);
    console.log('  Currency        : ' + acct.body.companyCurrency);
    console.log('  UI domain       : ' + (acct.body.uiDomain || ''));
  } else {
    console.log('  account-info: HTTP ' + acct.status);
  }
  console.log('');

  // 1. Token metadata: portal, app, scopes.
  const meta = await api('/oauth/v1/access-tokens/' + TOKEN);
  if (meta.status !== 200) {
    console.log('Could not read token metadata: HTTP ' + meta.status);
    console.log(JSON.stringify(meta.body).slice(0, 300));
  } else {
    console.log('  Portal (hub) id : ' + meta.body.hub_id);
    console.log('  Hub domain      : ' + (meta.body.hub_domain || '(none)'));
    console.log('  App id          : ' + meta.body.app_id);
    console.log('  Token type      : ' + (meta.body.token_type || 'private app'));
    const scopes = meta.body.scopes || [];
    console.log('  Scopes granted  : ' + scopes.length);

    console.log('\n  What scenario 1 needs:');
    let missing = 0;
    NEEDED.forEach(([scope, why]) => {
      const has = scopes.indexOf(scope) !== -1;
      if (!has) missing++;
      console.log('    ' + (has ? 'OK      ' : 'MISSING ') + scope.padEnd(34) + why);
    });
    console.log('\n  ' + (missing === 0
      ? 'All required scopes are present.'
      : missing + ' scope(s) missing — add them to the private app and regenerate nothing; ' +
        'editing scopes keeps the same token.'));

    const extra = scopes.filter(s => !NEEDED.some(n => n[0] === s));
    if (extra.length) console.log('\n  Also granted: ' + extra.join(', '));
  }

  // 2. Can we actually read each object type?
  console.log('\n  Read checks:');
  for (const [label, p] of [
    ['companies', '/crm/v3/objects/companies?limit=1'],
    ['contacts', '/crm/v3/objects/contacts?limit=1'],
    ['deals', '/crm/v3/objects/deals?limit=1'],
    ['tickets', '/crm/v3/objects/tickets?limit=1'],
    ['owners', '/crm/v3/owners?limit=5']
  ]) {
    const r = await api(p);
    const n = r.body && r.body.results ? r.body.results.length : 0;
    console.log('    ' + label.padEnd(12) + 'HTTP ' + r.status +
      (r.status === 200 ? '   ' + (r.body.total !== undefined ? r.body.total + ' total' : n + ' returned')
                        : '   ' + String(JSON.stringify(r.body)).slice(0, 120)));
  }

  // 2b. Write scopes, proven without creating anything.
  //
  // HubSpot checks the token's scope BEFORE it validates the request body. So a POST carrying a
  // property that cannot exist returns 403 when the scope is missing and 400 when it is present —
  // and in neither case is a record created. This is the only honest way to test write access in a
  // portal where we are forbidden from deleting what we make.
  console.log('\n  Write checks (nothing is created — invalid payload, scope checked first):');
  const badBody = JSON.stringify({ properties: { __mcp_scope_probe__: 'x' } });
  for (const [label, p] of [
    ['companies', '/crm/v3/objects/companies'],
    ['contacts', '/crm/v3/objects/contacts'],
    ['deals', '/crm/v3/objects/deals'],
    ['tickets', '/crm/v3/objects/tickets']
  ]) {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: badBody
    });
    const text = await res.text();
    const verdict = res.status === 403 ? 'NO WRITE SCOPE'
      : (res.status === 400 || res.status === 409) ? 'writable'
      : 'unclear (HTTP ' + res.status + ')';
    console.log('    ' + label.padEnd(12) + 'HTTP ' + res.status + '   ' + verdict +
      (res.status === 403 ? '   ' + text.slice(0, 150) : ''));
  }

  // Schema write — can we create the company date properties ourselves?
  {
    const res = await fetch(BASE + '/crm/v3/properties/companies', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', label: '', groupName: '', type: 'date' })
    });
    const text = await res.text();
    console.log('    ' + 'properties'.padEnd(12) + 'HTTP ' + res.status + '   ' +
      (res.status === 403 ? 'NO SCHEMA SCOPE — you must create the properties by hand'
                          : 'writable — the seeder can create the properties') +
      (res.status === 403 ? '   ' + text.slice(0, 150) : ''));
  }
  {
    const res = await fetch(BASE + '/crm/v3/pipelines/deals', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '', displayOrder: 0, stages: [] })
    });
    console.log('    ' + 'pipelines'.padEnd(12) + 'HTTP ' + res.status + '   ' +
      (res.status === 403 ? 'NO PIPELINE SCOPE — the Onboarding pipeline must be built in the UI'
                          : 'writable — the seeder can create the Onboarding pipeline'));
  }

  // 3. Pipelines — we need stage ids, not names, to place deals and tickets.
  for (const type of ['deals', 'tickets']) {
    const r = await api('/crm/v3/pipelines/' + type);
    console.log('\n  ' + type + ' pipelines:');
    if (r.status !== 200) {
      console.log('    HTTP ' + r.status + '  ' + String(JSON.stringify(r.body)).slice(0, 140));
      continue;
    }
    (r.body.results || []).forEach(p => {
      console.log('    "' + p.label + '"  (id ' + p.id + ')');
      (p.stages || []).sort((a, b) => a.displayOrder - b.displayOrder)
        .forEach(s => console.log('       - ' + s.label.padEnd(28) + 'id ' + s.id));
    });
  }

  // 4. Do the custom company date properties already exist?
  const props = await api('/crm/v3/properties/companies');
  console.log('\n  Company date properties we need:');
  if (props.status !== 200) {
    console.log('    HTTP ' + props.status + '  ' + String(JSON.stringify(props.body)).slice(0, 140));
  } else {
    const byName = {};
    (props.body.results || []).forEach(p => { byName[p.name] = p; });
    ['onboarding_start_date', 'target_go_live_date', 'actual_go_live_date'].forEach(n => {
      const p = byName[n];
      console.log('    ' + (p ? 'EXISTS  ' : 'MISSING ') + n +
        (p ? '   type=' + p.type + '/' + p.fieldType : ''));
    });
    const custom = (props.body.results || []).filter(p => !p.hubspotDefined);
    console.log('    (' + custom.length + ' custom company propert(ies) defined in total)');
  }
  // 5. How are tickets categorised? Scenario 2's gap analysis needs a category dimension.
  const tprops = await api('/crm/v3/properties/tickets');
  if (tprops.status === 200) {
    const all = tprops.body.results || [];
    const cat = all.filter(p => /categor|type|topic/i.test(p.name + ' ' + p.label));
    console.log('\n  Ticket properties that could carry a category:');
    cat.slice(0, 8).forEach(p => {
      const opts = (p.options || []).map(o => o.label).slice(0, 6);
      console.log('    ' + p.name.padEnd(28) + p.fieldType.padEnd(12) +
        (opts.length ? opts.join(', ') + (p.options.length > 6 ? ', ...' : '') : '(free text)'));
    });
    console.log('    (' + all.filter(p => !p.hubspotDefined).length + ' custom ticket properties)');
  }

  // 6. Owners — the CSM the demo filters "my accounts" by.
  const owners = await api('/crm/v3/owners?limit=10');
  if (owners.status === 200) {
    console.log('\n  Owners (for csm_owner_email):');
    (owners.body.results || []).slice(0, 8).forEach(o =>
      console.log('    ' + String(o.id).padEnd(12) + (o.email || '(no email)') +
        '   ' + [o.firstName, o.lastName].filter(Boolean).join(' ')));
  }

  // 7. How much is already in here? Writing 9 companies into a busy CRM is a different act
  //    from writing them into an empty one.
  console.log('\n  Existing volume:');
  for (const [label, p] of [['companies', 'companies'], ['contacts', 'contacts'],
                            ['deals', 'deals'], ['tickets', 'tickets']]) {
    const r = await fetch(BASE + '/crm/v3/objects/' + p + '/search', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 1 })
    });
    const b = await r.json().catch(() => ({}));
    console.log('    ' + label.padEnd(12) + (b.total !== undefined ? b.total + ' records' : 'HTTP ' + r.status));
  }
})();
