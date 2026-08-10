/**
 * HubSpotRefresh.gs — keeping a seeded HubSpot dataset true as time passes, and proving it did.
 *
 * WHY REFRESH EXISTS AT ALL
 *
 * Every date in this toolkit is an offset from the anchor T. Seed once and the records are correct
 * on that day and decay from then on. For scenario 2 the decay is fatal rather than cosmetic: its
 * whole story is "last 90 days versus the 90 days before", and a ticket seeded at T-88 slides out
 * of the recent window within a week. The 38 -> 13 integrations collapse flattens on its own and
 * nobody notices until a demo answer is wrong.
 *
 * LearnUpon forced two separate refresh paths because completion dates are write-once — a safe one
 * that shifts due dates, and a destructive Rebuild that deletes and recreates. HubSpot needs
 * neither split: ticket createdate and deal closedate are settable on UPDATE, confirmed by spike
 * and again by read-back. So one safe, idempotent, re-runnable path covers everything.
 *
 * HOW IT DECIDES WHAT A DATE SHOULD BE
 *
 * Not "shift everything forward by N days". It re-expands the plan against today's T and writes
 * each record to the date the plan says it should have. That keeps HubSpot consistent with the
 * LearnUpon side automatically, and it means running refresh twice in a row is a no-op rather than
 * pushing everything 2N days into the future.
 *
 * The identity string that drives the jitter is the record's natural key, which does not change, so
 * a ticket keeps its position within its window instead of jumping around on every refresh.
 */

function refreshHubSpotDates() {
  const gate = validateWorkbook({ silent: true });
  if (gate.errors > 0) {
    uiAlert('Refresh HubSpot dates — blocked',
      gate.errors + ' validation error(s). See the _Validation tab.');
    return;
  }

  hsResetCounters();
  const plan = scopedPlan();
  const index = manifestIndex();

  const byKey = {};
  plan.hubspot.tickets.forEach(t => { byKey[t.natural_key] = { kind: 'tickets', rec: t }; });
  plan.hubspot.deals.forEach(d => { byKey[d.natural_key] = { kind: 'deals', rec: d }; });
  plan.hubspot.companies.forEach(c => { byKey[c.natural_key] = { kind: 'companies', rec: c }; });

  const rows = manifestRows().filter(r =>
    String(r.platform) === 'hubspot' && inScope_(r.use_case, activeUseCase()) &&
    ['ticket', 'deal', 'company'].indexOf(String(r.object_type)) !== -1);

  if (!rows.length) {
    uiAlert('Refresh HubSpot dates — ' + scopeLabel(),
      'No HubSpot records in _Manifest for this scenario. Seed first.');
    return;
  }

  // Read current values back before deciding anything. The alternative — trusting the manifest to
  // know what is in the portal — is how the completions incident stayed invisible for a day.
  const work = { tickets: [], deals: [], companies: [] };
  const missing = [];
  const unchanged = { tickets: 0, deals: 0, companies: 0 };

  ['ticket', 'deal', 'company'].forEach(objectType => {
    const type = objectType + (objectType === 'company' ? 'ies' : 's');
    const typeKey = objectType === 'company' ? 'companies' : type;
    const mine = rows.filter(r => String(r.object_type) === objectType);
    if (!mine.length) return;

    const props = objectType === 'ticket' ? 'createdate,demo_source'
      : objectType === 'deal' ? 'closedate,demo_source'
      : 'onboarding_start_date,target_go_live_date,actual_go_live_date,demo_source';

    hsChunk_(mine).forEach(chunk => {
      const res = hsRequest_('post', '/crm/v3/objects/' + typeKey + '/batch/read', {
        properties: props.split(','),
        inputs: chunk.map(r => ({ id: String(r.external_id) }))
      }, { raw: true });

      const got = {};
      (((res.body || {}).results) || []).forEach(r => { got[String(r.id)] = r.properties || {}; });

      chunk.forEach(r => {
        const current = got[String(r.external_id)];
        const planned = byKey[r.natural_key];
        if (!current) { missing.push(r.natural_key + ' (id ' + r.external_id + ' not found)'); return; }
        if (!planned) { missing.push(r.natural_key + ' (no longer in the plan)'); return; }

        const want = {}, changes = [];
        const cmp = (prop, value) => {
          if (!value) return;
          if (String(current[prop] || '').slice(0, 10) === String(value).slice(0, 10)) return;
          want[prop] = value;
          changes.push(prop + ': ' + String(current[prop] || 'blank').slice(0, 10) + ' -> ' + value);
        };

        if (objectType === 'ticket') {
          cmp('createdate', new Date(planned.rec.created_at).toISOString().slice(0, 10));
        } else if (objectType === 'deal') {
          cmp('closedate', hsDate_(planned.rec.close_date));
        } else {
          cmp('onboarding_start_date', hsDate_(planned.rec.onboarding_start_date));
          cmp('target_go_live_date', hsDate_(planned.rec.target_go_live_date));
          cmp('actual_go_live_date', hsDate_(planned.rec.actual_go_live_date));
        }

        if (!changes.length) { unchanged[typeKey]++; return; }
        work[typeKey].push({ id: String(r.external_id), properties: want,
          label: r.natural_key, changes: changes });
      });
    });
  });

  const total = work.tickets.length + work.deals.length + work.companies.length;
  if (!total) {
    uiAlert('Refresh HubSpot dates — nothing to do',
      'Every HubSpot record already carries the date the plan says it should.\n\n' +
      'Checked: ' + unchanged.tickets + ' ticket(s), ' + unchanged.deals + ' deal(s), ' +
      unchanged.companies + ' company/companies.' +
      (missing.length ? '\n\nCould not check ' + missing.length + ' record(s) — run Verify.' : ''));
    return;
  }

  const sample = work.tickets.concat(work.deals).concat(work.companies).slice(0, 6);
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert('Refresh HubSpot dates',
    'PORTAL:   ' + hsPortalLabel_() + '\n' +
    'SCENARIO: ' + scopeLabel() + '\n' +
    'Anchor T: ' + plan.anchor + '\n\n' +
    'Move ' + total + ' record(s) to the dates the plan gives them today:\n' +
    '  ' + work.tickets.length + ' ticket(s), ' + work.deals.length + ' deal(s), ' +
    work.companies.length + ' company/companies\n' +
    '  ' + (unchanged.tickets + unchanged.deals + unchanged.companies) + ' already correct\n\n' +
    sample.map(w => '  ' + w.label + '\n      ' + w.changes.join('\n      ')).join('\n') +
    (total > 6 ? '\n  ... and ' + (total - 6) + ' more' : '') +
    '\n\nThis is an update, not a delete. Nothing is recreated.',
    ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;

  return withLock(function () {
    const runId = newRunId();
    const notes = [];
    let updated = 0, failed = 0;

    ['tickets', 'deals', 'companies'].forEach(type => {
      if (!work[type].length) return;
      const res = hsBatchUpdate_(type, work[type]);
      updated += res.updated;
      failed += work[type].length - res.updated;
      notes.push.apply(notes, res.errors);
    });

    logAction({ run_id: runId, action: 'Refresh HubSpot dates', phase: 'hs-refresh',
      platform: 'hubspot', object_type: 'ticket+deal+company', intended: total,
      succeeded: updated, failed: failed, notes: notes.slice(0, 3).join(' | ') });

    uiAlert('Refresh HubSpot dates — done',
      'Portal:   ' + hsPortalLabel_() + '\n' +
      'Scenario: ' + scopeLabel() + '\n\n' +
      'Updated: ' + updated + '\n' +
      'Failed:  ' + failed + '\n\n' +
      (notes.length ? notes.slice(0, 8).map(n => '  - ' + n).join('\n') : 'No errors.') +
      '\n\nRun Verify HubSpot to confirm the portal now matches the plan.');
  });
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Reconciles PLAN -> PORTAL, which is the direction that can actually find a problem.
 *
 * The manifest-to-portal check ("is everything we recorded still there?") passed cleanly through
 * both of this project's incidents, because it asks the one question whose answer cannot reveal a
 * missing or mis-shaped record. So this walks the plan instead and asks, per account and per
 * category, whether the portal holds what the demo is going to claim.
 *
 * It checks four things a seed can get wrong while reporting success:
 *   - the ticket landed, and in the stage the scenario asked for
 *   - it is associated to a company, so "which account" is answerable at all
 *   - its createdate is still inside the window it was declared in
 *   - the deal is in the pipeline the scenario named, not a fallback
 */
function verifyHubSpot() {
  hsResetCounters();
  const plan = scopedPlan();
  const index = manifestIndex();
  const T = new Date(plan.anchor + 'T00:00:00Z').getTime();
  const DAY = 86400000;

  const lines = [];
  const problems = [];

  // --- what the plan expects ----------------------------------------------
  const planned = plan.hubspot.tickets;
  if (!planned.length && !plan.hubspot.deals.length) {
    uiAlert('Verify HubSpot — ' + scopeLabel(), 'This scenario has no HubSpot records in its plan.');
    return;
  }

  const seeded = planned.filter(t => index[t.natural_key]);
  const notSeeded = planned.length - seeded.length;

  lines.push('Portal:   ' + hsPortalLabel_());
  lines.push('Scenario: ' + scopeLabel() + '     anchor T: ' + plan.anchor);
  lines.push('');
  lines.push('Tickets in plan: ' + planned.length + '     in manifest: ' + seeded.length +
    (notSeeded ? '     NOT SEEDED: ' + notSeeded : ''));
  if (notSeeded) problems.push(notSeeded + ' planned ticket(s) have never been seeded.');

  // --- read them back ------------------------------------------------------
  const stageLabelById = {};
  try {
    const res = hsRequest_('get', '/crm/v3/pipelines/tickets');
    ((res.body && res.body.results) || []).forEach(p =>
      (p.stages || []).forEach(s => { stageLabelById[String(s.id)] = s.label; }));
  } catch (e) { /* labels are cosmetic here */ }

  const actual = {};
  const noCompany = [];
  const wrongStage = [];
  const outOfWindow = [];

  // Associations come from the v4 endpoint, NOT from batch/read — v3 ignores an associations key
  // and returns 200 with nothing, which made this check report every ticket as unattached.
  const assocByTicket = hsAssociationsFor_('tickets', 'companies',
    seeded.map(t => index[t.natural_key].external_id));

  hsChunk_(seeded).forEach(chunk => {
    const res = hsRequest_('post', '/crm/v3/objects/tickets/batch/read', {
      properties: ['subject', 'ticket_category', 'createdate', 'hs_pipeline_stage', 'demo_source'],
      inputs: chunk.map(t => ({ id: String(index[t.natural_key].external_id) }))
    }, { raw: true });

    const got = {};
    (((res.body || {}).results) || []).forEach(r => { got[String(r.id)] = r; });

    chunk.forEach(t => {
      const id = String(index[t.natural_key].external_id);
      const r = got[id];
      if (!r) { problems.push(t.natural_key + ' is in the manifest but not in the portal'); return; }
      const p = r.properties || {};

      actual[t.account_key] = actual[t.account_key] || {};
      const cat = p.ticket_category || '(none)';
      actual[t.account_key][cat] = (actual[t.account_key][cat] || 0) + 1;

      if (!(assocByTicket[id] || []).length) noCompany.push(t.natural_key);

      const wantStage = String(t.stage_label || '').trim();
      const gotStage = stageLabelById[String(p.hs_pipeline_stage)] || p.hs_pipeline_stage;
      if (wantStage && hsNormalise_(wantStage) !== hsNormalise_(gotStage)) {
        wrongStage.push(t.natural_key + ': wanted "' + wantStage + '", portal says "' + gotStage + '"');
      }

      const age = (T - new Date(p.createdate).getTime()) / DAY;
      const plannedAge = (T - new Date(t.created_at).getTime()) / DAY;
      // More than a day apart means the portal date is not the date the plan gives it today.
      if (Math.abs(age - plannedAge) > 1) {
        outOfWindow.push(t.natural_key + ': portal ' + String(p.createdate).slice(0, 10) +
          ', plan ' + new Date(t.created_at).toISOString().slice(0, 10));
      }
    });
  });

  // --- the numbers the demo will actually show -----------------------------
  lines.push('');
  lines.push('Tickets per account, as the portal holds them');
  plan.stats.byAccount.forEach(a => {
    const mine = actual[a.account_key] || {};
    const total = Object.keys(mine).reduce((s, k) => s + mine[k], 0);
    const want = planned.filter(t => t.account_key === a.account_key).length;
    lines.push('  ' + pad_(a.account_key, 16) + pad_(String(total), 5) + ' of ' + want + ' planned' +
      (total === want ? '' : '   <-- MISMATCH'));
    if (total !== want) problems.push(a.account_key + ': ' + total + ' tickets in the portal, ' +
      want + ' in the plan.');
  });

  // --- the Story 1 table ---------------------------------------------------
  const catRows = tabRows(TAB.TICKET_CATEGORIES);
  const courseFor = k => (catRows.filter(c => String(c.category_key) === String(k))[0] || {}).course_key;
  const recent = {}, prior = {};
  seeded.forEach(t => {
    const days = (T - new Date(t.created_at).getTime()) / DAY;
    const bucket = days <= 90 ? recent : prior;
    bucket[t.category_key] = (bucket[t.category_key] || 0) + 1;
  });
  lines.push('');
  lines.push('By category — this is the table the demo answers from');
  lines.push('  ' + pad_('category', 26) + pad_('prior', 8) + pad_('last 90d', 10) + 'course');
  Object.keys(recent).concat(Object.keys(prior))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => (recent[b] || 0) - (recent[a] || 0))
    .forEach(k => {
      lines.push('  ' + pad_(k, 26) + pad_(String(prior[k] || 0), 8) +
        pad_(String(recent[k] || 0), 10) + (courseFor(k) || '*** NO COURSE ***'));
    });

  // --- deals ---------------------------------------------------------------
  if (plan.hubspot.deals.length) {
    lines.push('');
    lines.push('Deals');
    plan.hubspot.deals.forEach(d => {
      const m = index[d.natural_key];
      if (!m) { lines.push('  ' + pad_(d.name, 40) + 'NOT SEEDED');
                problems.push(d.name + ' has never been seeded.'); return; }
      try {
        const r = hsRequest_('get', '/crm/v3/objects/deals/' + m.external_id +
          '?properties=dealname,amount,closedate,dealstage,pipeline');
        const p = (r.body && r.body.properties) || {};
        lines.push('  ' + pad_(String(p.dealname), 40) + pad_(String(p.amount), 10) +
          'closes ' + String(p.closedate).slice(0, 10) + '   pipeline ' + p.pipeline);
      } catch (e) {
        lines.push('  ' + pad_(d.name, 40) + 'READ FAILED');
        problems.push(d.name + ': ' + String(e.message).slice(0, 120));
      }
    });
  }

  // --- the four ways a green seed can still be wrong -----------------------
  if (noCompany.length) {
    problems.push(noCompany.length + ' ticket(s) have NO company association, so "which account ' +
      'filed this?" cannot be answered for them.');
  }
  if (wrongStage.length) {
    problems.push(wrongStage.length + ' ticket(s) are in a different stage than the scenario asked ' +
      'for. First few:\n      ' + wrongStage.slice(0, 3).join('\n      '));
  }
  if (outOfWindow.length) {
    problems.push(outOfWindow.length + ' ticket(s) carry a date the plan no longer gives them — ' +
      'run Refresh HubSpot dates. First few:\n      ' + outOfWindow.slice(0, 3).join('\n      '));
  }

  lines.push('');
  lines.push(problems.length
    ? 'PROBLEMS (' + problems.length + ')\n' + problems.map(p => '  - ' + p).join('\n')
    : 'No problems. The portal matches the plan.');

  logAction({ run_id: newRunId(), action: 'Verify HubSpot', phase: 'hs-verify', platform: 'hubspot',
    object_type: 'ticket+deal', intended: planned.length, succeeded: seeded.length - problems.length,
    failed: problems.length, notes: problems.length ? 'PORTAL DOES NOT MATCH PLAN' : 'reconciled' });

  uiAlert('Verify HubSpot — ' + scopeLabel(), lines.join('\n'));
}
