'use strict';
// Small-scale, single-process scenario (no real crash/kill needed): does #2539 trust a checkpoint
// that PRE-FIX code already advanced past a record whose index write failed?
//
// Pre-fix runIndexing persists `lastIndexedKey` on an unconditional interval (every 100 records
// visited) with no check of `hadIndexingErrors` -- see the `if (++indexed % 100 === 0 ...)` block
// in resources/databases.ts before #2539. A record that fails to index but isn't itself on a
// checkpoint boundary gets silently overtaken by the next checkpoint. #2539's `persistCheckpoint`
// guards *its own* interval checkpoints with `if (hadIndexingErrors) return`, but that guard only
// protects checkpoints #2539's own code writes -- it does not retroactively re-validate a
// `lastIndexedKey` inherited on disk from a pre-fix run.
//
// modes:
//   poison   -- (run against a BASE (pre-fix) build) seed rows, inject one index-put failure at
//               FAILING_ID, let the backfill run to completion (uninterrupted -- old code doesn't
//               need to be killed to reproduce this, the bug is in the unconditional checkpoint
//               write, not the resume-from-zero bug). Reports the persisted checkpoint and
//               confirms it is past FAILING_ID, and that FAILING_ID is missing from the index.
//   resume   -- (run against the FIX build, pointed at a COPY of the `poison`-mode db) reopens the
//               table with the SAME indexed attributes with no further injected failures, awaits
//               completion, and reports whether FAILING_ID is present in the index and whether the
//               descriptor now claims the index is complete.
//   remediate-- (run against the FIX build, pointed at a COPY of the `poison`-mode db) clears the
//               persisted `lastIndexedKey` on disk (the proposed operational recovery: force a
//               full rescan) *before* the real resume attempt, then resumes and reports the same
//               checks as `resume`.
const path = require('node:path');
const { writeFileSync } = require('node:fs');

const DATABASE = 'poisoned';
const TABLE = 'PoisonedCheckpoint';
const FAILING_INDEX = 20; // 0-based row index whose index write will fail
const N = 300; // small: comfortably more than one 100-record checkpoint interval past FAILING_INDEX
const CHECKPOINT_INTERVAL = 100;

function pad(i) {
	return String(i).padStart(6, '0');
}
const FAILING_ID = 'p-' + pad(FAILING_INDEX);

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--db') args.db = argv[++i];
		else if (a === '--mode') args.mode = argv[++i];
		else if (a === '--result') args.result = argv[++i];
	}
	if (!args.db || !args.mode) throw new Error('--db and --mode are required');
	return args;
}

function findDescriptor(Tbl, attrName) {
	const prefix = Tbl.tableName + '/';
	for (const { key, value } of Tbl.dbisDB.getRange({ start: false })) {
		if (value && value.name === attrName && key.toString().startsWith(prefix)) return { key, value };
	}
	return null;
}

// Direct index-store lookup (the same {key: indexedValue, value: primaryKey} range shape
// resources/search.ts's searchByIndex reads), bypassing Table.search()'s isIndexing/indexingFailed
// guard (which correctly throws IndexRebuildingError instead of a silent under-return while a
// backfill is outstanding -- see completeness.js's isindexing-guard-check.js counter-finding). We
// need to see the raw index content itself, including a *completed* index that silently omitted a
// record.
function indexHasPrimaryKey(index, indexedValue, primaryKey) {
	for (const { value: id } of index.getRange({ start: indexedValue, end: indexedValue, inclusiveEnd: true, values: true })) {
		if (id === primaryKey) return true;
	}
	return false;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { initEnv } = require('./env.js');
	initEnv(args.db, DATABASE);
	const { setMainIsWorker } = require('#js/server/threads/manageThreads');
	setMainIsWorker(true);
	const { table } = require('#src/resources/databases');

	if (args.mode === 'poison') {
		let Tbl = table({ table: TABLE, database: DATABASE, attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'tag' }] });
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: 'p-' + pad(i), tag: 't-' + (i % 5) });
		await last;

		const { resetDatabases } = require('#src/resources/databases');
		resetDatabases();
		Tbl = table({
			table: TABLE,
			database: DATABASE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		const tagIndex = Tbl.indices.tag;
		const originalPut = tagIndex.put;
		let failed = false;
		tagIndex.put = function (indexedValue, primaryKey, options) {
			if (primaryKey === FAILING_ID && !failed) {
				failed = true;
				throw new Error(`simulated index-put failure at ${FAILING_ID} (pre-fix: checkpoint is not error-gated)`);
			}
			return originalPut.call(this, indexedValue, primaryKey, options);
		};
		await Tbl.indexingOperation;
		tagIndex.put = originalPut;

		const descriptor = findDescriptor(Tbl, 'tag');
		const checkpointRowIndex = descriptor.value.lastIndexedKey ? Number(descriptor.value.lastIndexedKey.slice(2)) : undefined;
		const indexHasFailingId = indexHasPrimaryKey(Tbl.indices.tag, 't-' + (FAILING_INDEX % 5), FAILING_ID);

		const result = {
			mode: 'poison',
			FAILING_ID,
			FAILING_INDEX,
			checkpointInterval: CHECKPOINT_INTERVAL,
			descriptorIndexingFailed: descriptor.value.indexingFailed,
			persistedLastIndexedKey: descriptor.value.lastIndexedKey,
			checkpointRowIndex,
			checkpointIsPastFailingRecord: checkpointRowIndex !== undefined && checkpointRowIndex > FAILING_INDEX,
			indexHasFailingId,
			primaryCount: Tbl.primaryStore.getKeysCount(),
			tagIndexCount: Tbl.indices.tag.getKeysCount(),
		};
		writeFileSync(args.result, JSON.stringify(result, null, 2));
		console.log(JSON.stringify(result, null, 2));
		process.exit(0);
	}

	if (args.mode === 'remediate') {
		// Fix the on-disk descriptor *before* any real resume gets a chance to trust it: open the
		// table (which synchronously arms a new indexingOperation against the still-poisoned
		// checkpoint) but exit before that operation's first await ever resolves, after overwriting
		// the persisted lastIndexedKey. Mirrors worker.js's `inspect` mode technique.
		const Tbl = table({
			table: TABLE,
			database: DATABASE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		const descriptor = findDescriptor(Tbl, 'tag');
		const before = { ...descriptor.value };
		descriptor.value.lastIndexedKey = undefined;
		Tbl.dbisDB.putSync(descriptor.key, descriptor.value);
		console.log(JSON.stringify({ mode: 'remediate', before, afterLastIndexedKey: undefined }, null, 2));
		process.exit(0);
	}

	if (args.mode === 'resume') {
		const Tbl = table({
			table: TABLE,
			database: DATABASE,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'tag', indexed: true },
			],
		});
		const beforeDescriptor = findDescriptor(Tbl, 'tag');
		const resumeStartedFrom = beforeDescriptor.value.lastIndexedKey;
		if (Tbl.indexingOperation) await Tbl.indexingOperation;
		const afterDescriptor = findDescriptor(Tbl, 'tag');
		const indexHasFailingId = indexHasPrimaryKey(Tbl.indices.tag, 't-' + (FAILING_INDEX % 5), FAILING_ID);
		const result = {
			mode: 'resume',
			resumeStartedFrom,
			FAILING_ID,
			afterIndexingFailed: afterDescriptor?.value.indexingFailed,
			afterLastIndexedKey: afterDescriptor?.value.lastIndexedKey,
			declaredComplete: afterDescriptor === null || (afterDescriptor.value.indexingFailed === undefined && afterDescriptor.value.lastIndexedKey === undefined),
			indexHasFailingId,
			primaryCount: Tbl.primaryStore.getKeysCount(),
			tagIndexCount: Tbl.indices.tag.getKeysCount(),
			gapSilentlyMissing: !indexHasFailingId,
		};
		writeFileSync(args.result, JSON.stringify(result, null, 2));
		console.log(JSON.stringify(result, null, 2));
		process.exit(0);
	}

	throw new Error(`unknown mode ${args.mode}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
