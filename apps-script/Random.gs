/**
 * Random.gs — deterministic jitter.
 *
 * Math.random() is not seedable in Apps Script, and reproducibility is a hard requirement.
 * A sequential seeded PRNG would be worse than useless here: inserting one ticket row would shift
 * every subsequent value and rewrite the whole dataset, which is unacceptable in a sheet three
 * people edit.
 *
 * So every "random" value is derived from a hash of the record's own identity. Identity strings are
 * stable and content-derived, e.g.
 *
 *     due|enr|alderfield|nce-admin-essentials|filler:alderfield:03
 *
 * Inserting an unrelated row changes nothing else. Same sheet contents + same prng_seed = same
 * output, every time.
 */

/** FNV-1a, 32-bit. Unit-tested for stability — changing this rewrites every jittered date. */
function hash32(str) {
  const s = String(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h ^= c & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    const hi = c >>> 8;
    if (hi) {
      h ^= hi;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

/** Integer in [0, rangeSize). */
function jitter(identity, seed, rangeSize) {
  if (!rangeSize || rangeSize <= 1) return 0;
  return hash32(identity + '|' + seed) % rangeSize;
}

/** Float in [0, 1). */
function hashFloat(identity, seed) {
  return hash32(identity + '|' + seed) / 4294967296;
}

/**
 * Stable, seed-dependent ordering. Used to decide which of the unpinned enrollees complete,
 * so it isn't always the first N filler learners.
 */
function orderByHash(items, identityFn, seed) {
  return items
    .map((item, i) => ({ item: item, i: i, k: hash32(identityFn(item) + '|' + seed) }))
    .sort((a, b) => (a.k - b.k) || (a.i - b.i))
    .map(x => x.item);
}

// ---------------------------------------------------------------------------
// Filler learner names
// ---------------------------------------------------------------------------

// Deliberately ordinary, no apostrophes (LearnUpon name fields and our email derivation both
// prefer it that way), and no overlap with the named personas in Scenario1.gs.
const FIRST_NAMES = [
  'Aisha', 'Alan', 'Amara', 'Andre', 'Anika', 'Bryn', 'Caleb', 'Carmen', 'Cheryl', 'Damian',
  'Deepa', 'Elena', 'Emeka', 'Erin', 'Farid', 'Gemma', 'Gustav', 'Hana', 'Hugo', 'Imani',
  'Ines', 'Jarek', 'Joanne', 'Kenji', 'Kiera', 'Lars', 'Leona', 'Malik', 'Marta', 'Nadia',
  'Neil', 'Nora', 'Omar', 'Paola', 'Quentin', 'Rosa', 'Rowan', 'Sanjay', 'Tessa', 'Yusuf'
];

const LAST_NAMES = [
  'Abbott', 'Barros', 'Beckett', 'Cardoso', 'Chen', 'Dalgaard', 'Devlin', 'Eriksen', 'Fanning',
  'Gallagher', 'Haddad', 'Hollis', 'Ibarra', 'Jansen', 'Kaminski', 'Kovac', 'Lindqvist', 'Lowry',
  'Maguire', 'Mbeki', 'Novak', 'Oduya', 'Pereira', 'Quinlan', 'Rahman', 'Renner', 'Salvatore',
  'Sandoval', 'Sorensen', 'Tanaka', 'Thornton', 'Ullman', 'Vasquez', 'Wexler', 'Whelan',
  'Yates', 'Zajac', 'Ashworth', 'Buchanan', 'Castellan'
];

/**
 * Deterministic display name for a generated learner. Two independent hashes so first and last
 * names vary independently.
 */
function deterministicName(identity, seed) {
  return {
    first: FIRST_NAMES[jitter('first|' + identity, seed, FIRST_NAMES.length)],
    last: LAST_NAMES[jitter('last|' + identity, seed, LAST_NAMES.length)]
  };
}
