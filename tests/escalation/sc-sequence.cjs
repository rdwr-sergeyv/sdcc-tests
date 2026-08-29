// Borrow-and-return for the Scrubbing Center sequence counter.
//
// WHY THIS EXISTS
//   `ScrubbingCenter.clean()` assigns `community_tag_sequence` from the global `Enumerators`
//   counter -- via `get_increment_uid` -- BEFORE `_validate_escalation_mapping()` runs. So the
//   counter advances on every create attempt, including ones the product then REJECTS, and deleting
//   the SC afterwards does not give the number back. `MAX_SC_NUM = 99` is compared against that
//   counter, not against how many SCs exist.
//
//   A guard suite is therefore a slow leak: each run makes a handful of deliberately-refused creates
//   plus one real probe SC, and each of those burns a number for good.
//
//   Measured on the lab 2026-08-29: `Enumerators.ScrubbingCenter.seq` reached exactly 99 with only
//   FOUR scrubbing centres in existence (sequences 1, 6, 8, 9). Every SC-creating test then failed
//   with "You have reached the Maximum Scrubbing centers allowed" -- the lab was wedged by its own
//   test suite, not by anything the product did wrong.
//
//   In production this is harmless: SCs are created rarely, and the counter stood at 30 after years.
//   It is only a test-harness problem, so the harness is what fixes it -- by putting the counter
//   back where it found it.
//
// USAGE
//   const { captureScSequence } = require('./sc-sequence.cjs');
//   let seq;
//   test.beforeAll(() => { seq = captureScSequence(); });
//   test.afterAll(() => { seq.restore(); });          // after any probe SCs are deleted
//
// Reaching Mongo needs the lab host (docker). Off-host, capture() degrades to a no-op and says so,
// so the HTTP-only suites still run from a laptop -- they simply leak, as they always have.

const { execFileSync } = require('child_process');

const MONGO_CONTAINER = process.env.LEGACY_PORTAL_MONGO_CONTAINER || 'legacy-portal-mongo-1';
const MONGO_DB = process.env.SDCC_MONGO_DB || 'sdcc';

function mongo(script) {
  return execFileSync(
    'docker',
    ['exec', MONGO_CONTAINER, 'mongosh', MONGO_DB, '--quiet', '--eval', script],
    { encoding: 'utf8' },
  ).trim();
}

function readSeq() {
  const out = mongo(
    'const e = db.Enumerators.findOne({_id: "ScrubbingCenter"}); print(e ? e.seq : "none");',
  );
  return out === 'none' ? null : Number(out);
}

/**
 * Read the counter now; `restore()` puts it back.
 *
 * restore() never lowers the counter below the highest sequence actually in use, so it cannot hand
 * out a number some surviving SC already holds -- a leaked probe SC keeps its number rather than
 * having it reissued underneath it.
 */
function captureScSequence() {
  let before = null;
  let reachable = true;
  try {
    before = readSeq();
  } catch (err) {
    reachable = false;
    // eslint-disable-next-line no-console
    console.warn(`sc-sequence: cannot reach Mongo (${err.message.split('\n')[0]}); `
      + 'the SC sequence counter will not be restored by this run.');
  }

  return {
    before,
    restore() {
      if (!reachable || before === null) return;
      try {
        const highestInUse = Number(mongo(
          'const xs = db.ScrubbingCenters.find({}, {community_tag_sequence: 1}).toArray()'
          + '.map(s => s.community_tag_sequence || 0);'
          + ' print(xs.length ? Math.max.apply(null, xs) : 0);',
        ));
        const target = Math.max(before, highestInUse);
        const now = readSeq();
        if (now === null || now <= target) return;
        mongo(`db.Enumerators.updateOne({_id: "ScrubbingCenter"}, {$set: {seq: ${target}}});`);
        // eslint-disable-next-line no-console
        console.log(`sc-sequence: returned ${now - target} burned number(s); seq ${now} -> ${target}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`sc-sequence: restore failed (${err.message.split('\n')[0]})`);
      }
    },
  };
}

module.exports = { captureScSequence, readScSequence: readSeq };
