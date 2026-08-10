/**
 * HubSpotSeed.gs — the HubSpot write phases.
 *
 * Same contract as Seed.gs: build a work list by diffing the plan against the manifest, confirm
 * with counts and the target portal, execute, append to the manifest, log.
 *
 * Three phases, in dependency order. Each is re-runnable and skips what the manifest already has.
 *
 *   1. Companies and contacts   — the objects everything else associates to
 *   2. Tickets                  — the volume, and the whole of scenario 2
 *   3. Deals                    — the number Story 3 closes on
 *
 * Differences from the LearnUpon phases, all forced by the platform:
 *
 *   - Records go up 100 at a time. A 230-ticket seed is 3 calls, not 230.
 *   - A batch response can be PARTIALLY successful. Results are matched back by our own
 *     demo_natural_key, never by array position, because a partial batch does not preserve order.
 *   - Associations are a separate call after the objects exist, so a phase that dies halfway leaves
 *     orphans rather than corruption. Re-running repairs them.
 *   - Adoption reads the whole object type once and maps it locally. HubSpot's search API is ~4
 *     req/sec, so a search per record would take longer than the entire seed.
 */

function seedHubSpotCompanies() { runHsPhase_('HubSpot: companies and contacts', hsPhaseCompanies_); }
function seedHubSpotTickets() { runHsPhase_('HubSpot: tickets', hsPhaseTickets_); }
function seedHubSpotDeals() { runHsPhase_('HubSpot: deals', hsPhaseDeals_); }

// ---------------------------------------------------------------------------
// Phase runner
// ---------------------------------------------------------------------------

function runHsPhase_(title, fn) {
  const gate = validateWorkbook({ silent: true });
  if (gate.errors > 0) {
    uiAlert(title + ' — blocked',
      gate.errors + ' validation error(s). Seeding refuses to run until they are fixed.\n\n' +
      'See the _Validation tab.');
    return;
  }

  hsResetCounters();
  const plan = scopedPlan();
  const index = manifestIndex();

  let work;
  try {
    work = fn.build(plan, index);
  } catch (e) {
    uiAlert(title + ' — failed to plan', String(e.message).slice(0, 500));
    return;
  }

  if (work.blocked && work.blocked.length) {
    uiAlert(title + ' — blocked',
      work.blocked.length + ' record(s) need a company or contact that is not in _Manifest yet.\n\n' +
      'Run "HubSpot: companies and contacts" to completion first, and let it finish before ' +
      'starting this one.\n\nExamples:\n' +
      work.blocked.slice(0, 8).map(b => '  - ' + b).join('\n') +
      (work.blocked.length > 8 ? '\n  ... and ' + (work.blocked.length - 8) + ' more' : ''));
    return;
  }

  if (!work.items.length) {
    uiAlert(title, 'Nothing to do — everything in the plan is already in the manifest.\n\n' +
      work.skipped + ' record(s) already seeded.');
    return;
  }

  if (!confirmWrite_(title, work)) return;

  return withLock(function () {
    const runId = newRunId();
    const result = fn.execute(work, runId, plan);

    logAction({
      run_id: runId, action: title, phase: fn.phase, platform: 'hubspot',
      object_type: fn.phase, intended: work.items.length,
      succeeded: result.succeeded, failed: result.failed,
      notes: result.notes.slice(0, 3).join(' | ')
    });

    uiAlert(title + ' — done',
      'Portal:   ' + environmentLabel() + '\n' +
      'Scenario: ' + scopeLabel() + '\n\n' +
      'Created:  ' + result.succeeded + '\n' +
      'Failed:   ' + result.failed + '\n' +
      'Skipped:  ' + work.skipped + ' (already in the manifest)\n' +
      (result.associated !== undefined ? 'Linked:   ' + result.associated + ' association(s)\n' : '') +
      '\n' +
      (result.notes.length
        ? 'Problems:\n' + result.notes.slice(0, 10).map(n => '  - ' + n).join('\n') +
          (result.notes.length > 10 ? '\n  ... and ' + (result.notes.length - 10) + ' more' : '')
        : 'No errors.') +
      '\n\nEvery created record is on _Manifest.');
  });
}

/** Every record we create carries both tags: one to adopt by, one to verify before deleting. */
function hsTag_(rec) {
  return {
    demo_natural_key: rec.natural_key,
    demo_source: String(getSetting('demo_tag', 'MCP-DEMO'))
  };
}

function hsDate_(d) {
  return d ? Utilities.formatDate(new Date(d), 'UTC', 'yyyy-MM-dd') : null;
}

/** Strips nulls — HubSpot rejects a batch outright if any property in it is unknown or invalid. */
function hsProps_(o) {
  const out = {};
  Object.keys(o).forEach(k => {
    if (o[k] !== null && o[k] !== undefined && o[k] !== '') out[k] = o[k];
  });
  return out;
}

// ---------------------------------------------------------------------------
// Phase 1 — companies and contacts
// ---------------------------------------------------------------------------

const hsPhaseCompanies_ = {
  phase: 'hs-companies',

  build: function (plan, index) {
    const items = [];
    let skipped = 0;
    plan.hubspot.companies.forEach(c => {
      if (index[c.natural_key]) { skipped++; return; }
      items.push({ kind: 'company', rec: c });
    });
    plan.hubspot.contacts.forEach(c => {
      if (index[c.natural_key]) { skipped++; return; }
      items.push({ kind: 'contact', rec: c });
    });
    return {
      items: items, skipped: skipped, noun: 'companies and contacts',
      preview: items.map(i => i.kind + '  ' + (i.rec.name || i.rec.email))
    };
  },

  execute: function (work, runId, plan) {
    const notes = [];
    let succeeded = 0, failed = 0, associated = 0;

    const companies = work.items.filter(i => i.kind === 'company').map(i => i.rec);
    const contacts = work.items.filter(i => i.kind === 'contact').map(i => i.rec);

    // Owner resolution: hubspot_owner_id takes the OWNER id, not the USER id. They are different
    // numbers for the same person and passing the wrong one fails with INVALID_OWNER_ID.
    const ownerCache = {};

    // --- companies ---------------------------------------------------------
    const companyIdByKey = {};
    if (companies.length) {
      const existing = hsIndexExisting_('companies', 'domain');
      const toCreate = [];

      companies.forEach(c => {
        // Adopt on our own key first, then on domain — the portal already holds 18 companies that
        // are not ours, and creating a second "Meridian Freight Systems" would split the story.
        const adopted = existing.byKey[c.natural_key] || existing.bySecondary[c.domain];
        if (adopted) {
          companyIdByKey[c.natural_key] = adopted;
          notes.push('adopted existing company ' + c.name + ' (id ' + adopted + ')');
          manifestAppend(runId, [{ platform: 'hubspot', object_type: 'company', class: 'persistent',
            external_id: adopted, natural_key: c.natural_key, use_case: c.use_case, extra: c.domain }]);
          // Stamp our tags onto the adopted record so Layer 2 can verify it later.
          hsBatchUpdate_('companies', [{ id: adopted, properties: hsTag_(c) }]);
          succeeded++;
          return;
        }
        let ownerId = null;
        try { ownerId = hsOwnerIdByEmail_(c.csm_owner_email, ownerCache); } catch (e) { /* optional */ }

        // industry is an enumeration of 148 fixed options. An unmatched value fails the entire
        // batch, not just its own record, so it is resolved here and dropped if unknown.
        const industry = c.industry ? hsEnumValue_('companies', 'industry', c.industry) : null;
        if (c.industry && !industry) {
          notes.push(c.name + ': industry "' + c.industry + '" is not one of HubSpot\'s options — ' +
            'left blank. Pick a label from the portal\'s industry dropdown.');
        }

        toCreate.push({
          natural_key: c.natural_key, rec: c,
          properties: hsProps_(Object.assign({
            name: c.name, domain: c.domain, industry: industry,
            annualrevenue: c.arr === null ? null : String(c.arr),
            hubspot_owner_id: ownerId,
            onboarding_start_date: hsDate_(c.onboarding_start_date),
            target_go_live_date: hsDate_(c.target_go_live_date),
            actual_go_live_date: hsDate_(c.actual_go_live_date)
          }, hsTag_(c)))
        });
      });

      const res = hsBatchCreate_('companies', toCreate);
      res.created.forEach(r => {
        companyIdByKey[r.natural_key] = r.id;
        manifestAppend(runId, [{ platform: 'hubspot', object_type: 'company', class: 'persistent',
          external_id: r.id, natural_key: r.natural_key, use_case: r.rec.use_case,
          extra: r.rec.domain }]);
        succeeded++;
      });
      failed += toCreate.length - res.created.length;
      notes.push.apply(notes, res.errors);
    }

    // Companies created in an earlier run are still needed as association targets.
    const index = manifestIndex();
    plan.hubspot.companies.forEach(c => {
      if (!companyIdByKey[c.natural_key]) {
        const id = manifestIdFor(index, c.natural_key);
        if (id) companyIdByKey[c.natural_key] = id;
      }
    });

    // --- contacts ----------------------------------------------------------
    if (contacts.length) {
      const existing = hsIndexExisting_('contacts', 'email');
      const toCreate = [];
      const pairs = [];

      contacts.forEach(c => {
        const adopted = existing.byKey[c.natural_key] || existing.bySecondary[c.email];
        if (adopted) {
          notes.push('adopted existing contact ' + c.email + ' (id ' + adopted + ')');
          manifestAppend(runId, [{ platform: 'hubspot', object_type: 'contact', class: 'persistent',
            external_id: adopted, natural_key: c.natural_key, use_case: c.use_case, extra: c.email }]);
          hsBatchUpdate_('contacts', [{ id: adopted, properties: hsTag_(c) }]);
          const companyId = companyIdByKey['hs:company:' + c.account_key];
          if (companyId) pairs.push({ from: adopted, to: companyId });
          succeeded++;
          return;
        }
        toCreate.push({
          natural_key: c.natural_key, rec: c,
          properties: hsProps_(Object.assign({
            email: c.email, firstname: c.first_name, lastname: c.last_name, jobtitle: c.job_title
          }, hsTag_(c)))
        });
      });

      const res = hsBatchCreate_('contacts', toCreate);
      res.created.forEach(r => {
        manifestAppend(runId, [{ platform: 'hubspot', object_type: 'contact', class: 'persistent',
          external_id: r.id, natural_key: r.natural_key, use_case: r.rec.use_case,
          extra: r.rec.email }]);
        const companyId = companyIdByKey['hs:company:' + r.rec.account_key];
        if (companyId) pairs.push({ from: r.id, to: companyId });
        succeeded++;
      });
      failed += toCreate.length - res.created.length;
      notes.push.apply(notes, res.errors);

      if (pairs.length) {
        const a = hsAssociate_('contacts', 'companies', pairs);
        associated += a.done;
        notes.push.apply(notes, a.errors);
      }
    }

    return { succeeded: succeeded, failed: failed, notes: notes, associated: associated };
  }
};

// ---------------------------------------------------------------------------
// Phase 2 — tickets
// ---------------------------------------------------------------------------

const hsPhaseTickets_ = {
  phase: 'hs-tickets',

  build: function (plan, index) {
    const items = [];
    const blocked = [];
    let skipped = 0;

    plan.hubspot.tickets.forEach(t => {
      if (index[t.natural_key]) { skipped++; return; }
      // A ticket with no company is unattributable, and the demo question is always "which
      // account". Refuse rather than create a floating record.
      if (!index['hs:company:' + t.account_key]) {
        blocked.push(t.subject + ' (needs company ' + t.account_key + ')');
        return;
      }
      items.push({ kind: 'ticket', rec: t });
    });

    return {
      items: items, skipped: skipped, blocked: blocked, noun: 'tickets',
      preview: items.map(i => '[' + i.rec.category_label + '] ' + i.rec.subject)
    };
  },

  execute: function (work, runId, plan) {
    const notes = [];
    let succeeded = 0, failed = 0, associated = 0;
    const index = manifestIndex();

    // Resolve the pipeline and its stage labels once. Stage IDs differ between portals, so the
    // scenario file names stages in words and this turns them into ids.
    let pipelineId = null;
    const stageIdByLabel = {};
    const ticketStageLabels = [];
    try {
      const res = hsRequest_('get', '/crm/v3/pipelines/tickets');
      const pipes = (res.body && res.body.results) || [];
      const support = pipes.filter(p => /support/i.test(p.label))[0] || pipes[0];
      if (support) {
        pipelineId = support.id;
        (support.stages || []).forEach(s => {
          stageIdByLabel[String(s.label).trim().toLowerCase()] = s.id;
          ticketStageLabels.push(s.label);
        });
      }
    } catch (e) {
      notes.push('could not read ticket pipelines: ' + String(e.message).slice(0, 160));
    }
    if (!pipelineId) {
      return { succeeded: 0, failed: work.items.length, associated: 0,
        notes: ['No ticket pipeline found. Run Setup -> HubSpot Pipelines to see what exists.'] };
    }

    // A stage we cannot resolve is REFUSED, not defaulted. Silently filing every "open" ticket as
    // Closed reads as success and produces the opposite of the intended story — exactly the shape
    // of failure this project has shipped twice before.
    const known = ticketStageLabels;
    const unresolved = {};
    const usable = [];
    work.items.map(i => i.rec).forEach(t => {
      const wanted = String(t.stage_label || '').trim().toLowerCase();
      if (!wanted || !stageIdByLabel[wanted]) {
        unresolved[t.stage_label || '(blank)'] = (unresolved[t.stage_label || '(blank)'] || 0) + 1;
        return;
      }
      usable.push(t);
    });

    if (Object.keys(unresolved).length) {
      return { succeeded: 0, failed: work.items.length, associated: 0, notes:
        ['REFUSED — these Tickets.status values are not stages in this pipeline:']
        .concat(Object.keys(unresolved).map(k => '    "' + k + '"  (' + unresolved[k] + ' ticket(s))'))
        .concat(['Valid stages are: ' + known.join(', '),
                 'Fix Tickets.status in the scenario file, then run this phase again.',
                 'Nothing was created — a ticket in the wrong stage tells the wrong story.']) };
    }

    const toCreate = usable.map(t => {
      const stage = stageIdByLabel[String(t.stage_label).trim().toLowerCase()];

      return {
        natural_key: t.natural_key, rec: t,
        properties: hsProps_(Object.assign({
          subject: t.subject,
          content: t.subject + '\n\nReported by ' + (t.contact_email || 'unknown') +
            ' at ' + t.company_name + '.',
          hs_pipeline: String(pipelineId),
          hs_pipeline_stage: String(stage),
          hs_ticket_priority: t.priority,
          ticket_category: t.category_key,
          // Spike-confirmed settable on create AND on update, which is what makes ticket dates
          // refreshable rather than write-once.
          createdate: new Date(t.created_at).toISOString()
        }, hsTag_(t)))
      };
    });

    const res = hsBatchCreate_('tickets', toCreate);
    const companyPairs = [], contactPairs = [];

    res.created.forEach(r => {
      manifestAppend(runId, [{ platform: 'hubspot', object_type: 'ticket', class: 'disposable',
        external_id: r.id, natural_key: r.natural_key, use_case: r.rec.use_case,
        parent_external_id: manifestIdFor(index, 'hs:company:' + r.rec.account_key),
        extra: r.rec.category_key }]);
      succeeded++;

      const companyId = manifestIdFor(index, 'hs:company:' + r.rec.account_key);
      if (companyId) companyPairs.push({ from: r.id, to: companyId });
      const contactId = r.rec.contact_natural_key
        ? manifestIdFor(index, r.rec.contact_natural_key) : null;
      if (contactId) contactPairs.push({ from: r.id, to: contactId });
    });
    failed += toCreate.length - res.created.length;
    notes.push.apply(notes, res.errors);

    if (companyPairs.length) {
      const a = hsAssociate_('tickets', 'companies', companyPairs);
      associated += a.done;
      notes.push.apply(notes, a.errors);
    }
    if (contactPairs.length) {
      const a = hsAssociate_('tickets', 'contacts', contactPairs);
      associated += a.done;
      notes.push.apply(notes, a.errors);
    }

    return { succeeded: succeeded, failed: failed, notes: notes, associated: associated };
  }
};

// ---------------------------------------------------------------------------
// Phase 3 — deals
// ---------------------------------------------------------------------------

const hsPhaseDeals_ = {
  phase: 'hs-deals',

  build: function (plan, index) {
    const items = [];
    const blocked = [];
    let skipped = 0;
    plan.hubspot.deals.forEach(d => {
      if (index[d.natural_key]) { skipped++; return; }
      if (!index['hs:company:' + d.account_key]) {
        blocked.push(d.name + ' (needs company ' + d.account_key + ')');
        return;
      }
      items.push({ kind: 'deal', rec: d });
    });
    return {
      items: items, skipped: skipped, blocked: blocked, noun: 'deals',
      preview: items.map(i => i.rec.name + '  ' + i.rec.amount)
    };
  },

  execute: function (work, runId) {
    const notes = [];
    let succeeded = 0, failed = 0, associated = 0;
    const index = manifestIndex();

    const pipelines = {};
    const stagesByPipeline = {};
    const stageLabels = {};      // readable labels for the refusal message
    const pipelineLabels = [];
    try {
      const res = hsRequest_('get', '/crm/v3/pipelines/deals');
      ((res.body && res.body.results) || []).forEach(p => {
        pipelines[hsNormalise_(p.label)] = p.id;
        pipelineLabels.push(p.label);
        const m = stagesByPipeline[p.id] = {};
        stageLabels[p.id] = (p.stages || []).map(s => s.label);
        (p.stages || []).forEach(s => { m[hsNormalise_(s.label)] = s.id; });
      });
    } catch (e) {
      notes.push('could not read deal pipelines: ' + String(e.message).slice(0, 160));
    }

    // Same rule as tickets, and it matters more here: falling back to Sales Pipeline would put
    // nine onboarding deals worth half a million at "Appointment Scheduled" and report success.
    const toCreate = [];
    const refusals = [];
    work.items.map(i => i.rec).forEach(d => {
      const pipelineId = pipelines[hsNormalise_(d.pipeline_label)];
      if (!pipelineId) {
        refusals.push(d.name + ': pipeline "' + d.pipeline_label + '" does not exist in this ' +
          'portal. Pipelines here: ' + pipelineLabels.join(', '));
        return;
      }
      const stages = stagesByPipeline[pipelineId] || {};
      const stageId = stages[hsNormalise_(d.stage_label)];
      if (!stageId) {
        refusals.push(d.name + ': stage "' + d.stage_label + '" is not in the ' + d.pipeline_label +
          ' pipeline. Valid stages: ' + (stageLabels[pipelineId] || []).join(', '));
        return;
      }
      toCreate.push({
        natural_key: d.natural_key, rec: d,
        properties: hsProps_(Object.assign({
          dealname: d.name,
          pipeline: String(pipelineId),
          dealstage: String(stageId),
          amount: d.amount === null ? null : String(d.amount),
          closedate: hsDate_(d.close_date),
          dealtype: d.deal_type === 'renewal' ? 'existingbusiness' : 'newbusiness'
        }, hsTag_(d)))
      });
    });

    if (refusals.length) {
      return { succeeded: 0, failed: work.items.length, associated: 0, notes:
        ['REFUSED — nothing was created:'].concat(refusals.map(r => '    ' + r))
        .concat(['Run Setup -> Create / Update HubSpot Pipelines to create the Onboarding pipeline,',
                 'or correct pipeline/stage in the scenario file. Then run this phase again.']) };
    }

    const res = hsBatchCreate_('deals', toCreate);
    const pairs = [];
    res.created.forEach(r => {
      manifestAppend(runId, [{ platform: 'hubspot', object_type: 'deal', class: 'disposable',
        external_id: r.id, natural_key: r.natural_key, use_case: r.rec.use_case,
        parent_external_id: manifestIdFor(index, 'hs:company:' + r.rec.account_key),
        extra: r.rec.deal_type }]);
      succeeded++;
      const companyId = manifestIdFor(index, 'hs:company:' + r.rec.account_key);
      if (companyId) pairs.push({ from: r.id, to: companyId });
    });
    failed += toCreate.length - res.created.length;
    notes.push.apply(notes, res.errors);

    if (pairs.length) {
      const a = hsAssociate_('deals', 'companies', pairs);
      associated += a.done;
      notes.push.apply(notes, a.errors);
    }

    return { succeeded: succeeded, failed: failed, notes: notes, associated: associated };
  }
};

// ---------------------------------------------------------------------------
// Reset — HubSpot
// ---------------------------------------------------------------------------

/**
 * Archives this scenario's tickets and deals. Recoverable for about 90 days.
 *
 * Companies and contacts are PERSISTENT and are never touched, exactly as LearnUpon users and
 * groups are not: they are the join keys the whole demo rests on, and re-creating them would
 * scatter the association graph.
 *
 * Every delete goes through hsArchiveVerified_, which refuses anything without our tag. Never use
 * the GDPR delete endpoint — that one is permanent.
 */
function resetHubSpot() {
  const scope = activeUseCase();
  const rows = manifestRows().filter(r =>
    String(r.platform) === 'hubspot' &&
    (r.object_type === 'ticket' || r.object_type === 'deal') &&
    inScope_(r.use_case, scope));

  if (!rows.length) {
    uiAlert('Reset HubSpot — ' + scopeLabel(),
      'No HubSpot tickets or deals in _Manifest for this scenario.\n\n' +
      'Reset only ever deletes what the manifest records, so there is nothing to do.');
    return;
  }

  const byType = {};
  rows.forEach(r => { byType[r.object_type] = (byType[r.object_type] || 0) + 1; });

  const ok = uiConfirmTyped('RESET ' + String(scope).toUpperCase(),
    'PORTAL:   ' + environmentLabel() + '\n' +
    'SCENARIO: ' + scopeLabel() + '\n\n' +
    'About to ARCHIVE:\n' +
    Object.keys(byType).map(k => '  ' + byType[k] + ' ' + k + '(s)').join('\n') + '\n\n' +
    'Companies and contacts are NOT touched.\n' +
    'Archived records are recoverable in HubSpot for about 90 days.');
  if (!ok) return;

  hsResetCounters();
  return withLock(function () {
    const runId = newRunId();
    const removed = [], notes = [];
    let archived = 0, refused = 0;

    rows.forEach(r => {
      const type = r.object_type === 'ticket' ? 'tickets' : 'deals';
      try {
        const res = hsArchiveVerified_(type, r.external_id, r.natural_key);
        if (res.ok) {
          archived++;
          removed.push(r.natural_key);   // ledger row goes only after the delete is confirmed
        } else {
          refused++;
          notes.push(r.natural_key + ': ' + res.skipped);
        }
      } catch (e) {
        refused++;
        notes.push(r.natural_key + ': ' + String(e.message).slice(0, 140));
      }
    });

    manifestRemove(removed);
    logAction({ run_id: runId, action: 'Reset HubSpot', phase: 'hs-reset', platform: 'hubspot',
      object_type: 'ticket+deal', intended: rows.length, succeeded: archived, failed: refused,
      notes: notes.slice(0, 3).join(' | ') });

    uiAlert('Reset HubSpot — done',
      'Archived: ' + archived + '\n' +
      'Refused:  ' + refused + (refused ? '  (not ours, or already gone)' : '') + '\n\n' +
      (notes.length ? notes.slice(0, 10).map(n => '  - ' + n).join('\n') : 'No problems.') +
      '\n\nCompanies and contacts were not touched.');
  });
}
