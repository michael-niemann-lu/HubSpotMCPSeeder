/**
 * Manifest.gs — the ledger, and the only authority for deletion.
 *
 * Every record we create is appended here with its platform id. Reset reads ONLY from this tab and
 * never discovers records by searching the portal. If a record is not in the manifest it does not
 * get touched, even if it looks like ours. That rule is the reason a bug in this toolkit cannot
 * damage the 60+ groups of other people's demo data living in the same portal.
 *
 * Rows are keyed by natural_key, which is stable across runs and independent of platform ids:
 *   user:person:alderfield.dana   group:alderfield   course:nce-getting-started
 *   enr:nce-getting-started:user:filler:alderfield:03
 */

const MANIFEST_COLS = ['run_id', 'created_at', 'platform', 'object_type', 'class',
  'external_id', 'natural_key', 'use_case', 'parent_external_id', 'extra', 'environment'];

/**
 * EVERY read is scoped to the current environment, because natural keys are portal-independent but
 * external ids are not. Without this, pointing the sheet at ACME would make the seeder skip
 * everything as "already seeded" while Reset looked up sandbox ids in ACME — where a 404 reads as
 * "already gone" and would quietly delete the sandbox's ledger.
 *
 * Rows written before this column existed are treated as `test`, which is where they were made.
 */
function manifestRows() {
  const env = currentEnvironment();
  return manifestAllRows_().filter(r => (String(r.environment || '').trim() || 'test') === env);
}

/** Unfiltered. Only for rewriting the tab — a scoped rewrite would erase the other environment. */
function manifestAllRows_() {
  return tabRows(TAB.MANIFEST);
}

/** natural_key -> row. Later rows win, so a re-seed after a manual manifest edit behaves sanely. */
function manifestIndex() {
  const index = {};
  manifestRows().forEach(r => {
    if (r.natural_key) index[String(r.natural_key)] = r;
  });
  return index;
}

function manifestIdFor(index, naturalKey) {
  const row = index[naturalKey];
  return row ? String(row.external_id) : null;
}

/**
 * Appends records. Call this immediately after each successful write, not in a batch at the end:
 * if the run dies halfway, the ledger must still describe reality.
 */
function manifestAppend(runId, records) {
  if (!records || !records.length) return;
  const at = nowIso();
  appendTabRows(TAB.MANIFEST, records.map(r => [
    runId, at, r.platform || 'learnupon', r.object_type, r.class,
    String(r.external_id), r.natural_key, r.use_case || '',
    r.parent_external_id === undefined ? '' : String(r.parent_external_id),
    r.extra === undefined ? '' : String(r.extra),
    currentEnvironment()
  ]));
}

/** Removes rows by natural key. Only ever called after the platform delete has been confirmed. */
function manifestRemove(naturalKeys) {
  if (!naturalKeys || !naturalKeys.length) return 0;
  const drop = {};
  naturalKeys.forEach(k => { drop[String(k)] = true; });

  // Scoped by environment for the match, unscoped for the rewrite.
  const env = currentEnvironment();
  const all = manifestAllRows_();
  const kept = all.filter(r =>
    !(drop[String(r.natural_key)] && (String(r.environment || '').trim() || 'test') === env));
  const removed = all.length - kept.length;
  replaceTabBody(TAB.MANIFEST, kept.map(r => MANIFEST_COLS.map(c => r[c] === undefined ? '' : r[c])));
  return removed;
}

function manifestCounts() {
  const counts = {};
  manifestRows().forEach(r => {
    const k = String(r.object_type || '?');
    counts[k] = (counts[k] || 0) + 1;
  });
  return counts;
}

function manifestByType(objectType) {
  return manifestRows().filter(r => String(r.object_type) === objectType);
}


/**
 * Rewrites external_ids in one pass. A rebuild changes every enrollment id, and calling
 * replaceTabBody once per record would mean hundreds of full-tab rewrites.
 * changes: { naturalKey: newExternalId }
 */
function manifestUpdateIds(changes) {
  const keys = Object.keys(changes || {});
  if (!keys.length) return 0;
  const env = currentEnvironment();
  let touched = 0;
  const rows = manifestAllRows_().map(r => {
    const mine = (String(r.environment || '').trim() || 'test') === env;
    if (mine && changes[String(r.natural_key)] !== undefined) {
      r.external_id = String(changes[String(r.natural_key)]);
      touched++;
    }
    return r;
  });
  replaceTabBody(TAB.MANIFEST, rows.map(r => MANIFEST_COLS.map(c => r[c] === undefined ? '' : r[c])));
  return touched;
}
