/**
 * ScenarioLoader.gs — the shared machinery behind Scenario1.gs, Scenario2.gs and Scenario3.gs.
 *
 * Each scenario file holds nothing but data plus a five-line loader. This file does the work, so
 * all three behave identically and there is one place to fix when they don't.
 *
 * The flow those files sit in:
 *
 *   ScenarioN.gs  --Load-->  sheet rows for that use case  --Seed-->  LearnUpon + HubSpot
 *
 * Load OVERWRITES that scenario's rows. Hand edits made in the sheet survive until the next Load,
 * and then they are gone. That is deliberate: one rule ("the file wins on Load") is easier to hold
 * in your head than a merge.
 */

/**
 * The three scenarios, and the functions each file is expected to provide.
 * A missing file is not an error — the menu says so and moves on.
 */
function scenarioRegistry() {
  return [
    { use_case: 'uc1', loader: 'loadScenario1', meta: 'scenario1Meta', expected: 'scenario1Expected' },
    { use_case: 'uc2', loader: 'loadScenario2', meta: 'scenario2Meta', expected: 'scenario2Expected' },
    { use_case: 'uc3', loader: 'loadScenario3', meta: 'scenario3Meta', expected: 'scenario3Expected' }
  ];
}

function scenarioInstalled_(useCase) {
  const entry = scenarioRegistry().filter(r => r.use_case === useCase)[0];
  if (!entry) return false;
  try { return typeof globalThis[entry.loader] === 'function'; } catch (e) { return false; }
}

/** Runs a scenario's loader, or explains why it cannot. Used by the per-scenario menus. */
function runScenarioLoader_(useCase) {
  const entry = scenarioRegistry().filter(r => r.use_case === useCase)[0];
  const fn = entry && globalThis[entry.loader];
  if (typeof fn !== 'function') {
    uiAlert('Load ' + useCase,
      'No data file is installed for ' + useCase + '.\n\n' +
      'Paste apps-script/Scenario' + String(useCase).replace('uc', '') + '.gs into the Apps Script ' +
      'editor, then reload the sheet.');
    return;
  }
  fn();
}

/**
 * The one entry point every scenario file calls.
 *
 * builders is a map of tab name -> function returning an array of rows. Tabs you leave out are
 * untouched, so a scenario with no tickets simply omits Tickets.
 */
function loadScenarioData_(meta, builders) {
  const useCase = String(meta.use_case).trim();
  const ui = SpreadsheetApp.getUi();

  const existing = tabRows(TAB.ACCOUNTS).filter(a => String(a.use_case).trim() === useCase).length;
  const res = ui.alert('Load ' + useCase + ' — ' + (meta.name || ''),
    'This replaces every ' + useCase + ' row in the authoring tabs with the contents of the ' +
    'scenario file.\n\n' +
    (existing
      ? 'ANY HAND EDITS YOU HAVE MADE TO ' + useCase + ' ROWS WILL BE LOST (' + existing +
        ' account(s) currently in the sheet).\n\n'
      : '') +
    'Other scenarios are not touched. Nothing is written to any portal.',
    ui.ButtonSet.OK_CANCEL);
  if (res !== ui.Button.OK) return;

  const problems = [];
  const written = [];
  Object.keys(builders).forEach(tabName => {
    let rows;
    try {
      rows = builders[tabName]() || [];
    } catch (e) {
      problems.push(tabName + ': builder threw — ' + e.message);
      return;
    }
    const bad = checkRowWidths_(tabName, rows);
    if (bad.length) { problems.push.apply(problems, bad); return; }
    writeScenarioTab_(tabName, rows, useCase);
    written.push(tabName + ' (' + rows.length + ')');
  });

  upsertScenarioRow_(meta);

  if (problems.length) {
    uiAlert('Load ' + useCase + ' — stopped',
      'Nothing was written for the tabs below. Fix the scenario file and load again.\n\n' +
      problems.slice(0, 10).map(p => '  - ' + p).join('\n') +
      (problems.length > 10 ? '\n  ... and ' + (problems.length - 10) + ' more' : '') +
      (written.length ? '\n\nLoaded anyway: ' + written.join(', ') : ''));
    return;
  }

  // Validate straight away. Finding a broken reference now beats finding it three steps later.
  const gate = withScope_(useCase, function () { return validateWorkbook({ silent: true }); });

  uiAlert('Load ' + useCase + ' — done',
    (meta.name || useCase) + '\n\n' +
    'Loaded: ' + written.join(', ') + '\n\n' +
    (gate.errors
      ? gate.errors + ' validation error(s) — see the _Validation tab. Seeding is blocked until ' +
        'they are fixed.'
      : 'Validation clean' + (gate.warnings ? ' (' + gate.warnings + ' warning(s))' : '') + '.') +
    '\n\nNext: Preview to see the plan, then Seed.');
}

/**
 * Catches the most likely editing mistake: adding a field to a row and forgetting the column, or
 * the reverse. Positional arrays give no other warning — the data just silently shifts one place.
 */
function checkRowWidths_(tabName, rows) {
  const spec = tabSpecs().filter(s => s.name === tabName)[0];
  if (!spec) return [tabName + ': not a known tab'];
  const width = spec.cols.length;
  const problems = [];
  rows.forEach((r, i) => {
    if (!Array.isArray(r)) {
      problems.push(tabName + ' row ' + (i + 1) + ': not an array');
    } else if (r.length !== width) {
      problems.push(tabName + ' row ' + (i + 1) + ': ' + r.length + ' values, expected ' + width +
        '. Columns are: ' + spec.cols.map(c => c.h).join(', '));
    }
  });
  return problems;
}

/** Replaces only this scenario's rows, then restores the formula columns the write blanked out. */
function writeScenarioTab_(tabName, rows2d, useCase) {
  const spec = tabSpecs().filter(x => x.name === tabName)[0];
  if (!spec) return;
  const cols = spec.cols.map(c => c.h);
  const existing = tabRows(tabName);
  const toRow = r => cols.map(c => (r[c] === undefined ? '' : r[c]));

  let kept;
  if (cols.indexOf('use_case') !== -1) {
    kept = existing.filter(r => String(r.use_case).trim() !== useCase).map(toRow);
  } else {
    // TicketCategories has no use_case: one shared taxonomy across all three scenarios. Merge by
    // key rather than wiping, so one scenario can add a category without removing another's.
    const keyCol = cols[0];
    const incoming = {};
    rows2d.forEach(r => { incoming[String(r[0])] = true; });
    kept = existing.filter(r => !incoming[String(r[keyCol])]).map(toRow);
  }

  replaceTabBody(tabName, kept.concat(rows2d));
  applyFormulas_(SpreadsheetApp.getActive(), spec);
}

/** Keeps the Scenarios tab in step with what the file says about itself. */
function upsertScenarioRow_(meta) {
  const useCase = String(meta.use_case).trim();
  const spec = tabSpecs().filter(s => s.name === TAB.SCENARIOS)[0];
  const cols = spec.cols.map(c => c.h);
  const rows = tabRows(TAB.SCENARIOS);

  const updated = rows.map(r => {
    if (String(r.use_case).trim() !== useCase) return cols.map(c => r[c] === undefined ? '' : r[c]);
    return [useCase, meta.name || r.scenario_name, meta.owner_name || r.owner_name,
      meta.owner_email || r.owner_email, r.status || 'designing', meta.notes || r.notes || ''];
  });
  if (!rows.filter(r => String(r.use_case).trim() === useCase).length) {
    updated.push([useCase, meta.name || '', meta.owner_name || '', meta.owner_email || '',
      'designing', meta.notes || '']);
  }
  replaceTabBody(TAB.SCENARIOS, updated);
}

/**
 * The headline numbers a scenario says it is aiming for. Informative, not enforced — Verify shows
 * them next to what the portal actually holds so the gap is visible at a glance.
 */
function scenarioExpectedFor(useCase) {
  const entry = scenarioRegistry().filter(r => r.use_case === useCase)[0];
  if (!entry) return null;
  try {
    const fn = globalThis[entry.expected];
    return typeof fn === 'function' ? fn() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Developer -> Show Column Contract.
 * Scenario files are positional arrays, so this is the reference you need when editing one.
 */
function showColumnContract() {
  const lines = ['Column order for scenario file builders.',
    'Each row you return must have exactly this many values, in this order.', ''];
  tabSpecs().forEach(spec => {
    if (spec.owned) return;
    lines.push(spec.name + '  (' + spec.cols.length + ' columns)');
    spec.cols.forEach((c, i) => {
      lines.push('   ' + (i + 1) + '. ' + c.h + (c.f ? '   <- computed, pass an empty string' : ''));
    });
    lines.push('');
  });
  uiAlert('Column contract', lines.join('\n'));
}
