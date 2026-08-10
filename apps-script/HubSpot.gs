/**
 * HubSpot.gs — the HTTP client, the property schema, and the read-only setup checks.
 *
 * Same shape as LearnUpon.gs so there is one mental model for both platforms, but the constraints
 * are different enough to be worth stating:
 *
 *   - Batch endpoints take 100 records per call, which is the whole reason a 230-ticket seed fits
 *     inside the 6-minute limit. LearnUpon has no equivalent and goes one at a time.
 *   - The Search API is roughly 4 requests/second against ~19/second for everything else. Never
 *     build a search-per-record loop. We page the object type once and build a local map instead.
 *   - A batch HTTP 200 does NOT mean every record in it succeeded. 207 MULTI_STATUS is the normal
 *     partial-failure response and the per-item errors live in the body.
 *
 * The portal is shared with other people's demo data (93 contacts and 34 deals that are not ours),
 * so the manifest-only-deletion discipline from CLAUDE.md applies here exactly as it does in ACME.
 */

const HS_BASE = 'https://api.hubapi.com';
const HS_MAX_CALLS_PER_RUN = 600;
const HS_MIN_INTERVAL_MS = 120;      // ~8/sec, comfortably under the ~19/sec ceiling
const HS_SEARCH_INTERVAL_MS = 320;   // ~3/sec, under the much stricter ~4/sec search ceiling
const HS_MAX_ATTEMPTS = 3;
const HS_BATCH_SIZE = 100;

/** Object types we touch, and the association pairs we create between them. */
const HS_TYPES = ['companies', 'contacts', 'tickets', 'deals'];

let HS_CALLS_MADE = 0;
let HS_LAST_CALL_AT = 0;

function hsResetCounters() {
  HS_CALLS_MADE = 0;
  HS_LAST_CALL_AT = 0;
}

/**
 * The single choke point for every HubSpot call.
 * opts: { allow404: true } treats 404 as a normal result; { raw: true } returns 4xx bodies instead
 * of throwing; { search: true } applies the slower search pacing.
 */
function hsRequest_(method, path, payload, opts) {
  opts = opts || {};
  const token = hubspotToken_();

  if (HS_CALLS_MADE >= HS_MAX_CALLS_PER_RUN) {
    throw new Error('HubSpot call cap reached (' + HS_MAX_CALLS_PER_RUN + ' in one execution). ' +
      'This is our own stop, not HubSpot\'s — re-run the phase to continue where it left off.');
  }

  const interval = opts.search ? HS_SEARCH_INTERVAL_MS : HS_MIN_INTERVAL_MS;
  const params = {
    method: method,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    muteHttpExceptions: true
  };
  if (payload) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(payload);
  }

  let res = null, code = 0, lastError = '';
  for (let attempt = 1; attempt <= HS_MAX_ATTEMPTS; attempt++) {
    const since = Date.now() - HS_LAST_CALL_AT;
    if (HS_LAST_CALL_AT && since < interval) Utilities.sleep(interval - since);

    try {
      res = UrlFetchApp.fetch(HS_BASE + path, params);
    } catch (e) {
      lastError = String(e.message);
      Utilities.sleep(1000 * attempt);
      continue;
    } finally {
      HS_CALLS_MADE++;
      HS_LAST_CALL_AT = Date.now();
    }

    code = res.getResponseCode();
    if (code === 429) { Utilities.sleep(4000 * attempt); continue; }
    if (code >= 500) { Utilities.sleep(1500 * attempt); continue; }
    break;
  }

  if (!res) throw new Error(method.toUpperCase() + ' ' + path + ' failed: ' + lastError);

  const text = res.getContentText();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }

  if (code === 404 && opts.allow404) return { code: code, body: body, raw: text };
  if (code >= 400 && opts.raw) return { code: code, body: body, raw: text };
  if (code >= 400) {
    const detail = body && body.message ? body.message : String(text).slice(0, 300);
    throw new Error(method.toUpperCase() + ' ' + path + ' returned HTTP ' + code + '. ' + detail);
  }
  return { code: code, body: body, raw: text };
}

function hubspotToken_() {
  const creds = getCreds();
  const token = String(creds.hubspotToken || '').trim();
  if (!token) {
    throw new Error('No HubSpot token for the ' + currentEnvironment() + ' environment. ' +
      'Set ' + (currentEnvironment() === 'test' ? 'HS_TEST_TOKEN' : 'HS_DEMO_TOKEN') +
      ' via Setup -> Set Credentials.');
  }
  return token;
}

// ---------------------------------------------------------------------------
// Properties — the schema this toolkit owns
// ---------------------------------------------------------------------------

/**
 * demo_natural_key is what makes seeding idempotent and deletion safe. It carries the same stable
 * key the manifest uses, so a record can be adopted after a lost manifest and tag-verified before
 * any delete. demo_source is the human-readable half of the same idea.
 *
 * The date properties are the ones the portal recon found missing; ticket_category is load-bearing
 * for scenario 2, whose entire first story is "these categories have no training behind them".
 */
function hsPropertySpecs_() {
  const tag = [
    { name: 'demo_natural_key', label: 'Demo Natural Key', type: 'string', fieldType: 'text',
      description: 'Stable key from the MCP demo seeder. Used to adopt and to verify before delete.' },
    { name: 'demo_source', label: 'Demo Source', type: 'string', fieldType: 'text',
      description: 'Marks a record created by the MCP demo seeder.' }
  ];
  return {
    companies: tag.concat([
      { name: 'onboarding_start_date', label: 'Onboarding Start Date', type: 'date', fieldType: 'date' },
      { name: 'target_go_live_date', label: 'Target Go-Live Date', type: 'date', fieldType: 'date' },
      { name: 'actual_go_live_date', label: 'Actual Go-Live Date', type: 'date', fieldType: 'date' }
    ]),
    contacts: tag.slice(),
    deals: tag.slice(),
    tickets: tag.concat([
      { name: 'ticket_category', label: 'Ticket Category', type: 'enumeration', fieldType: 'select',
        description: 'What the ticket is about. The gap analysis groups by this.', options: [] }
    ])
  };
}

const HS_GROUPS = {
  companies: 'companyinformation',
  contacts: 'contactinformation',
  deals: 'dealinformation',
  tickets: 'ticketinformation'
};

/**
 * Creates the properties this toolkit needs, and keeps ticket_category's dropdown in step with the
 * TicketCategories tab. Never deletes a property — that is a schema change a human should make
 * deliberately, and dropping one would strip the values off other people's records.
 */
function setupHubSpotProperties() {
  const ui = SpreadsheetApp.getUi();
  const specs = hsPropertySpecs_();

  // The dropdown comes from the sheet, so adding a category is a data edit, not a code change.
  const cats = tabRows(TAB.TICKET_CATEGORIES).filter(c => c.category_key);
  specs.tickets.filter(p => p.name === 'ticket_category').forEach(p => {
    p.options = cats.map((c, i) => ({
      label: String(c.label || c.category_key),
      value: String(c.category_key),
      displayOrder: i
    }));
  });
  if (!cats.length) {
    uiAlert('HubSpot properties', 'The TicketCategories tab is empty, so ticket_category would have ' +
      'no options. Load a scenario first.');
    return;
  }

  const plan = [];
  Object.keys(specs).forEach(type => {
    specs[type].forEach(p => plan.push({ type: type, prop: p }));
  });

  const ok = ui.alert('Create / update HubSpot properties',
    'PORTAL: ' + environmentLabel() + '\n\n' +
    'This creates ' + plan.length + ' custom properties if they are missing, and updates the ' +
    'ticket_category dropdown to the ' + cats.length + ' categories on the TicketCategories tab.\n\n' +
    'Nothing is deleted. Existing properties keep their values.',
    ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;

  hsResetCounters();
  return withLock(function () {
    const runId = newRunId();
    const created = [], updated = [], failed = [];

    plan.forEach(entry => {
      const type = entry.type, p = entry.prop;
      try {
        const existing = hsRequest_('get', '/crm/v3/properties/' + type + '/' + p.name,
          null, { allow404: true });

        if (existing.code === 404) {
          const payload = {
            name: p.name, label: p.label, type: p.type, fieldType: p.fieldType,
            groupName: HS_GROUPS[type], description: p.description || ''
          };
          if (p.options) payload.options = p.options;
          hsRequest_('post', '/crm/v3/properties/' + type, payload);
          created.push(type + '.' + p.name);
          manifestAppend(runId, [{ platform: 'hubspot', object_type: 'property', class: 'schema',
            external_id: p.name, natural_key: 'prop:' + type + ':' + p.name, use_case: 'all',
            extra: type }]);
        } else if (p.options && p.options.length) {
          // Merge rather than replace: another scenario may have added a category we do not know.
          const have = {};
          ((existing.body && existing.body.options) || []).forEach(o => { have[o.value] = true; });
          const merged = ((existing.body && existing.body.options) || []).concat(
            p.options.filter(o => !have[o.value]));
          if (merged.length !== ((existing.body && existing.body.options) || []).length) {
            hsRequest_('patch', '/crm/v3/properties/' + type + '/' + p.name, { options: merged });
            updated.push(type + '.' + p.name + ' (+' +
              (merged.length - existing.body.options.length) + ' options)');
          }
        }
      } catch (e) {
        failed.push(type + '.' + p.name + ': ' + String(e.message).slice(0, 140));
      }
    });

    uiAlert('HubSpot properties',
      'PORTAL: ' + environmentLabel() + '\n\n' +
      'Created: ' + (created.length ? '\n  ' + created.join('\n  ') : 'none (all present)') + '\n\n' +
      'Updated: ' + (updated.length ? '\n  ' + updated.join('\n  ') : 'none') + '\n\n' +
      (failed.length ? 'FAILED:\n  ' + failed.join('\n  ') : 'No errors.'));
  });
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

/**
 * Pipelines this toolkit needs but a fresh portal does not have.
 *
 * Deal stages are ORDERED, and the order is the story: a deal sitting at "Data Migration" three
 * weeks before go-live means something specific. Deriving the order from the Deals tab would give
 * account order, not pipeline order, so it lives here as code.
 *
 * Only the deal pipeline is created. Tickets already have a Support Pipeline with sensible stages,
 * and inventing a second one would split ticket reporting across two pipelines for no gain.
 */
function hsPipelineSpecs_() {
  return [{
    objectType: 'deals',
    label: 'Onboarding',
    stages: [
      { label: 'Kickoff', probability: '0.2' },
      { label: 'Data Migration', probability: '0.4' },
      { label: 'Training & Enablement', probability: '0.6' },
      { label: 'UAT', probability: '0.8' },
      { label: 'Go-Live', probability: '1.0', closed: true }
    ]
  }];
}

/**
 * Creates missing pipelines and adds missing stages to ones that exist.
 *
 * Never removes a stage or a pipeline. Deals live on stages, and deleting one would move other
 * people's records somewhere arbitrary.
 */
function setupHubSpotPipelines() {
  const ui = SpreadsheetApp.getUi();
  const specs = hsPipelineSpecs_();

  const ok = ui.alert('Create / update HubSpot pipelines',
    'PORTAL: ' + environmentLabel() + '\n\n' +
    'This creates these pipelines if they are missing:\n' +
    specs.map(s => '  ' + s.label + ' (' + s.objectType + '): ' +
      s.stages.map(st => st.label).join(' -> ')).join('\n') + '\n\n' +
    'Nothing is renamed or deleted. Existing pipelines only gain missing stages.',
    ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;

  hsResetCounters();
  return withLock(function () {
    const runId = newRunId();
    const lines = [];

    specs.forEach(spec => {
      try {
        const res = hsRequest_('get', '/crm/v3/pipelines/' + spec.objectType);
        const existing = ((res.body && res.body.results) || [])
          .filter(p => hsNormalise_(p.label) === hsNormalise_(spec.label))[0];

        const stagePayload = spec.stages.map((st, i) => ({
          label: st.label,
          displayOrder: i,
          metadata: spec.objectType === 'deals'
            ? { isClosed: st.closed ? 'true' : 'false', probability: st.probability }
            : { ticketState: st.closed ? 'CLOSED' : 'OPEN' }
        }));

        if (!existing) {
          const made = hsRequest_('post', '/crm/v3/pipelines/' + spec.objectType,
            { label: spec.label, displayOrder: 99, stages: stagePayload });
          const id = made.body && made.body.id;
          lines.push('CREATED  ' + spec.label + ' (' + spec.objectType + ')  id ' + id);
          ((made.body && made.body.stages) || []).forEach(st =>
            lines.push('           ' + st.label + '  id ' + st.id));
          manifestAppend(runId, [{ platform: 'hubspot', object_type: 'pipeline', class: 'schema',
            external_id: String(id), natural_key: 'pipeline:' + spec.objectType + ':' + spec.label,
            use_case: 'all', extra: spec.objectType }]);
          return;
        }

        // Exists — add only the stages it is missing, keeping everyone else's stages untouched.
        const have = {};
        (existing.stages || []).forEach(st => { have[hsNormalise_(st.label)] = st; });
        const missing = spec.stages.filter(st => !have[hsNormalise_(st.label)]);
        if (!missing.length) {
          lines.push('OK       ' + spec.label + ' already has all ' + spec.stages.length + ' stages');
          return;
        }
        missing.forEach((st, i) => {
          hsRequest_('post', '/crm/v3/pipelines/' + spec.objectType + '/' + existing.id + '/stages', {
            label: st.label,
            displayOrder: (existing.stages || []).length + i,
            metadata: spec.objectType === 'deals'
              ? { isClosed: st.closed ? 'true' : 'false', probability: st.probability }
              : { ticketState: st.closed ? 'CLOSED' : 'OPEN' }
          });
        });
        lines.push('UPDATED  ' + spec.label + '  added: ' + missing.map(m => m.label).join(', '));
      } catch (e) {
        lines.push('FAILED   ' + spec.label + ': ' + String(e.message).slice(0, 200));
      }
    });

    uiAlert('HubSpot pipelines',
      'PORTAL: ' + environmentLabel() + '\n\n' + lines.join('\n') +
      '\n\nRun Setup -> Show HubSpot Pipelines to see the full list with stage ids.');
  });
}

// ---------------------------------------------------------------------------
// Read-only checks
// ---------------------------------------------------------------------------

/** Confirms the token works and says which portal it opens, before anything writes. */
function checkHubSpotCredentials() {
  hsResetCounters();
  try {
    const info = hsRequest_('get', '/account-info/v3/details');
    const b = info.body || {};
    const props = hsRequest_('get', '/crm/v3/properties/tickets?archived=false');
    const have = {};
    ((props.body && props.body.results) || []).forEach(p => { have[p.name] = true; });
    const specs = hsPropertySpecs_();
    const missing = [];
    Object.keys(specs).forEach(type => {
      specs[type].forEach(p => { if (type === 'tickets' && !have[p.name]) missing.push('tickets.' + p.name); });
    });

    uiAlert('HubSpot — connected',
      'Portal id:    ' + (b.portalId || '?') + '\n' +
      'Account type: ' + (b.accountType || '?') + '\n' +
      'Time zone:    ' + (b.timeZone || '?') + '\n' +
      'Currency:     ' + (b.companyCurrency || '?') + '\n\n' +
      (missing.length
        ? 'Missing ticket properties: ' + missing.join(', ') +
          '\n\nRun Setup -> Create HubSpot Properties.'
        : 'Ticket properties present.') +
      '\n\nThis portal holds other people\'s demo data. Only records in _Manifest are ever deleted.');
  } catch (e) {
    uiAlert('HubSpot — FAILED', String(e.message).slice(0, 600));
  }
}

/**
 * hubspot_owner_id takes the OWNER id, not the USER id — HubSpot issues a person both and they are
 * different numbers. Passing a user id fails with INVALID_OWNER_ID, which is why this resolves
 * through the owners endpoint and matches on email rather than trusting an id from another screen.
 */
function hsOwnerIdByEmail_(email, cache) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  if (cache && cache._loaded) return cache[key] || null;

  const res = hsRequest_('get', '/crm/v3/owners?limit=100');
  const map = cache || {};
  ((res.body && res.body.results) || []).forEach(o => {
    if (o.email) map[String(o.email).toLowerCase()] = String(o.id);
  });
  map._loaded = true;
  return map[key] || null;
}

/** Shows the pipelines and stages available, so a scenario file can name real ones. */
function checkHubSpotPipelines() {
  hsResetCounters();
  try {
    const lines = [];
    ['tickets', 'deals'].forEach(type => {
      const res = hsRequest_('get', '/crm/v3/pipelines/' + type);
      lines.push(type.toUpperCase());
      ((res.body && res.body.results) || []).forEach(p => {
        lines.push('  ' + p.label + '   id ' + p.id);
        (p.stages || []).sort((a, b) => a.displayOrder - b.displayOrder).forEach(s => {
          lines.push('      ' + s.label + '   id ' + s.id);
        });
      });
      lines.push('');
    });
    uiAlert('HubSpot pipelines', 'PORTAL: ' + environmentLabel() + '\n\n' + lines.join('\n'));
  } catch (e) {
    uiAlert('HubSpot pipelines — FAILED', String(e.message).slice(0, 600));
  }
}

// ---------------------------------------------------------------------------
// Adoption — page once, map locally
// ---------------------------------------------------------------------------

/**
 * Builds natural_key -> id for one object type by paging it, NOT by searching per record.
 * The search API is ~4 req/sec; a search per record would take longer than the whole seed.
 *
 * Also returns a secondary index (domain for companies, email for contacts) so a company that
 * already exists in the portal under someone else's demo data is adopted rather than duplicated.
 */
function hsIndexExisting_(type, secondaryProp) {
  const byKey = {};
  const bySecondary = {};
  const props = ['demo_natural_key'].concat(secondaryProp ? [secondaryProp] : []);
  let after = null, pages = 0;

  do {
    const q = '/crm/v3/objects/' + type + '?limit=100&properties=' + props.join(',') +
      (after ? '&after=' + encodeURIComponent(after) : '');
    const res = hsRequest_('get', q);
    const body = res.body || {};
    (body.results || []).forEach(r => {
      const p = r.properties || {};
      if (p.demo_natural_key) byKey[String(p.demo_natural_key)] = String(r.id);
      if (secondaryProp && p[secondaryProp]) {
        bySecondary[String(p[secondaryProp]).trim().toLowerCase()] = String(r.id);
      }
    });
    after = body.paging && body.paging.next ? body.paging.next.after : null;
    pages++;
  } while (after && pages < 40);   // 4000 records is far beyond anything we seed

  return { byKey: byKey, bySecondary: bySecondary, pages: pages };
}

// ---------------------------------------------------------------------------
// Batch writes
// ---------------------------------------------------------------------------

function hsChunk_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += (size || HS_BATCH_SIZE)) {
    out.push(arr.slice(i, i + (size || HS_BATCH_SIZE)));
  }
  return out;
}

/**
 * Creates records in batches and returns { created: [{key, id}], errors: [string] }.
 *
 * inputs is [{ natural_key, properties }]. The natural key is written into demo_natural_key by the
 * caller, so a record can always be found again.
 *
 * A batch returns 201 when everything worked and 207 MULTI_STATUS when some rows failed. Treating
 * either as blanket success is exactly the mistake CLAUDE.md prohibits, so per-item results are
 * matched back by demo_natural_key rather than by position.
 */
function hsBatchCreate_(type, inputs) {
  const created = [];
  const errors = [];

  hsChunk_(inputs).forEach(chunk => {
    const res = hsRequest_('post', '/crm/v3/objects/' + type + '/batch/create',
      { inputs: chunk.map(i => ({ properties: i.properties })) }, { raw: true });

    const body = res.body || {};
    if (res.code >= 400 && !body.results) {
      errors.push(type + ' batch of ' + chunk.length + ' failed: HTTP ' + res.code + ' ' +
        String(body.message || res.raw).slice(0, 200));
      return;
    }

    // Match on our own key, never on array position — a partial batch does not preserve order.
    const idByKey = {};
    (body.results || []).forEach(r => {
      const k = r.properties && r.properties.demo_natural_key;
      if (k) idByKey[String(k)] = String(r.id);
    });
    chunk.forEach(i => {
      const id = idByKey[i.natural_key];
      if (id) created.push({ natural_key: i.natural_key, id: id, rec: i.rec });
      else errors.push(type + ' ' + i.natural_key + ': no id returned');
    });
    (body.errors || []).forEach(e => {
      errors.push(type + ': ' + String(e.message || e.category).slice(0, 200));
    });
  });

  return { created: created, errors: errors };
}

/** Updates in batches. inputs is [{ id, properties }]. */
function hsBatchUpdate_(type, inputs) {
  let updated = 0;
  const errors = [];
  hsChunk_(inputs).forEach(chunk => {
    const res = hsRequest_('post', '/crm/v3/objects/' + type + '/batch/update',
      { inputs: chunk.map(i => ({ id: i.id, properties: i.properties })) }, { raw: true });
    const body = res.body || {};
    if (res.code >= 400 && !body.results) {
      errors.push(type + ' batch update failed: HTTP ' + res.code + ' ' +
        String(body.message || '').slice(0, 200));
      return;
    }
    updated += (body.results || []).length;
    (body.errors || []).forEach(e => errors.push(type + ': ' + String(e.message).slice(0, 200)));
  });
  return { updated: updated, errors: errors };
}

/**
 * Associates records using the DEFAULT association type for the pair, which spares us hard-coding
 * type ids that differ between portals.
 *
 * pairs is [{ from, to }] of ids. Batched 100 at a time through the v4 endpoint.
 */
function hsAssociate_(fromType, toType, pairs) {
  let done = 0;
  const errors = [];
  hsChunk_(pairs).forEach(chunk => {
    const res = hsRequest_('post',
      '/crm/v4/associations/' + fromType + '/' + toType + '/batch/associate/default',
      { inputs: chunk.map(p => ({ from: { id: String(p.from) }, to: { id: String(p.to) } })) },
      { raw: true });
    const body = res.body || {};
    if (res.code >= 400 && !body.results) {
      errors.push(fromType + '->' + toType + ': HTTP ' + res.code + ' ' +
        String(body.message || '').slice(0, 200));
      return;
    }
    done += (body.results || []).length;
    (body.errors || []).forEach(e => errors.push(String(e.message).slice(0, 200)));
  });
  return { done: done, errors: errors };
}

/**
 * Resolves a human label against an enumeration property's allowed options.
 *
 * This exists because HubSpot rejects the WHOLE BATCH when one record carries an invalid
 * enumeration value — 99 good companies fail because the hundredth says "Logistics" and the portal
 * only knows "Logistics and Supply Chain". The scenario files stay human-readable and this turns
 * their labels into whatever the portal actually accepts, or drops the property and says so.
 *
 * Matching is deliberately loose: case, spaces, ampersands, slashes and hyphens are all ignored,
 * so "Oil & Energy", "oil energy" and "OIL_ENERGY" are the same thing.
 */
const HS_ENUM_CACHE = {};

function hsEnumValue_(type, property, label) {
  const wanted = String(label || '').trim();
  if (!wanted) return null;

  const cacheKey = type + '.' + property;
  if (!HS_ENUM_CACHE[cacheKey]) {
    const map = {};
    try {
      const res = hsRequest_('get', '/crm/v3/properties/' + type + '/' + property);
      ((res.body && res.body.options) || []).forEach(o => {
        map[hsNormalise_(o.label)] = o.value;
        map[hsNormalise_(o.value)] = o.value;
      });
    } catch (e) { /* property may not exist; treated as "no match" below */ }
    HS_ENUM_CACHE[cacheKey] = map;
  }
  return HS_ENUM_CACHE[cacheKey][hsNormalise_(wanted)] || null;
}

function hsNormalise_(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Reads associations for a batch of records: returns { fromId: [toId, ...] }.
 *
 * This exists because the v3 batch/read endpoint SILENTLY IGNORES an `associations` key and returns
 * HTTP 200 with no associations at all — the same hazard as LearnUpon's ignored query parameters,
 * and it made Verify report that every ticket was unattached when all of them were fine. A check
 * that cries wolf gets switched off, so it has to use the endpoint that actually answers.
 */
function hsAssociationsFor_(fromType, toType, ids) {
  const out = {};
  hsChunk_(ids).forEach(chunk => {
    const res = hsRequest_('post',
      '/crm/v4/associations/' + fromType + '/' + toType + '/batch/read',
      { inputs: chunk.map(id => ({ id: String(id) })) }, { raw: true });
    (((res.body || {}).results) || []).forEach(r => {
      const from = String(r.from && r.from.id);
      out[from] = (r.to || []).map(t => String(t.toObjectId));
    });
  });
  return out;
}

/**
 * Archives a record — recoverable for about 90 days.
 *
 * Layer 2 of the safety model: fetch first and confirm OUR tag. A missing tag, a different natural
 * key or a failed fetch means skip and warn, never delete. This is what protects the 93 contacts
 * and 34 deals in this portal that belong to other people.
 *
 * Never use the GDPR delete endpoint — that one is permanent.
 */
function hsArchiveVerified_(type, id, expectedKey) {
  const got = hsRequest_('get', '/crm/v3/objects/' + type + '/' + id +
    '?properties=demo_natural_key,demo_source', null, { allow404: true });

  if (got.code === 404) return { ok: true, skipped: 'already gone' };
  const p = (got.body && got.body.properties) || {};
  if (!p.demo_source) {
    return { ok: false, skipped: 'no demo_source tag — not ours, refusing to archive' };
  }
  if (expectedKey && String(p.demo_natural_key) !== String(expectedKey)) {
    return { ok: false, skipped: 'natural key is "' + p.demo_natural_key + '", manifest says "' +
      expectedKey + '" — refusing to archive' };
  }
  hsRequest_('delete', '/crm/v3/objects/' + type + '/' + id, null, { allow404: true });
  return { ok: true };
}
