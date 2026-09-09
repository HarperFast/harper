'use strict';
// Child-process worker for the index-backfill-convergence repro. Two modes:
//
//   seed   -- writes `rows` records through the normal Table.put path (no indexed attributes
//             exist yet), then exits 0.
//   index  -- reopens the SAME table with its attributes marked `indexed: true`. If any attribute
//             has never been indexed (or was parked with indexingFailed), this triggers a real
//             runIndexing() backfill (resources/databases.ts). The parent process may SIGKILL this
//             child at an arbitrary wall-clock point to simulate an external watchdog/supervisor
//             kill; there is no graceful-shutdown handling here on purpose, matching the real
//             production failure (an uncontrolled interruption), and the same technique
//             unitTests/resources/indexBackfillConvergence-crash.js uses.
//
// Before the backfill can visit any primary-store record, this process wraps
// Table.primaryStore.getRange to record the `start` key it was opened with and the first key
// actually visited, writing that to <resultPath>.started.json synchronously so the observation
// survives a SIGKILL that lands before the backfill finishes (or even visits its first record).
// On a clean finish, the full gate-check result (primary vs index key counts, indexed search vs
// full scan) is written to <resultPath>.
const { writeFileSync } = require('node:fs');

function parseArgs(argv) {
	const args = { numAttrs: 2, rows: 0 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--db') args.db = argv[++i];
		else if (a === '--database') args.database = argv[++i];
		else if (a === '--table') args.table = argv[++i];
		else if (a === '--mode') args.mode = argv[++i];
		else if (a === '--rows') args.rows = Number(argv[++i]);
		else if (a === '--num-attrs') args.numAttrs = Number(argv[++i]);
		else if (a === '--result') args.result = argv[++i];
	}
	for (const required of ['db', 'database', 'table', 'mode', 'result']) {
		if (!args[required]) throw new Error(`--${required} is required`);
	}
	return args;
}

// Writes the `.started.json` marker synchronously, in the same synchronous stretch of JS that
// calls getRange and visits the first record, so the observation survives an external SIGKILL that
// lands before this process's event loop ever gets a free timer/macrotask turn (the very
// microtask-starvation behavior this repro is measuring on the pre-fix build).
function observeRange(store, markerPath) {
	const original = store.getRange;
	const observed = { start: undefined, firstKeys: [], count: 0, startRecorded: false };
	store.getRange = function (options) {
		if (!observed.startRecorded) {
			observed.start = options?.start;
			observed.startRecorded = true;
			writeFileSync(markerPath, JSON.stringify({ start: observed.start, firstKeys: [], visitedSoFar: 0 }));
		}
		const inner = original.call(this, options);
		return {
			[Symbol.iterator]() {
				const iterator = inner[Symbol.iterator]();
				return {
					next: () => {
						const result = iterator.next();
						if (!result.done) {
							observed.count++;
							if (observed.firstKeys.length < 5) {
								observed.firstKeys.push(result.value.key);
								writeFileSync(
									markerPath,
									JSON.stringify({ start: observed.start, firstKeys: observed.firstKeys, visitedSoFar: observed.count })
								);
							}
						}
						return result;
					},
					return: () => iterator.return?.(),
				};
			},
		};
	};
	return observed;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { initEnv } = require('./env.js');
	initEnv(args.db, args.database);
	const { setMainIsWorker } = require('#js/server/threads/manageThreads');
	setMainIsWorker(true);
	const { defineTable, generateRow } = require('./schema.js');

	if (args.mode === 'seed') {
		const Tbl = defineTable({ database: args.database, tableName: args.table, numAttrs: args.numAttrs, indexed: false });
		const { transaction } = require('#src/resources/transaction');
		const BATCH = 5000;
		let last;
		for (let batchStart = 0; batchStart < args.rows; batchStart += BATCH) {
			const batchEnd = Math.min(batchStart + BATCH, args.rows);
			await transaction(() => {
				for (let i = batchStart; i < batchEnd; i++) last = Tbl.put(generateRow(i, args.numAttrs));
			});
		}
		await last;
		process.exit(0);
	}

	if (args.mode === 'index') {
		const resultStartedPath = args.result + '.started.json';
		const Tbl = defineTable({ database: args.database, tableName: args.table, numAttrs: args.numAttrs, indexed: true });
		const observed = observeRange(Tbl.primaryStore, resultStartedPath);

		if (!Tbl.indexingOperation) {
			writeFileSync(
				resultStartedPath,
				JSON.stringify({ start: undefined, firstKeys: [], visitedSoFar: 0, alreadyComplete: true })
			);
		} else {
			await Tbl.indexingOperation;
		}

		// Independent gate check, computed in this same process after the backfill this process ran
		// reports completion (a fuller independent check also runs separately via report.js).
		const primaryCount = Tbl.primaryStore.getKeysCount();
		const indexCounts = {};
		const searchChecks = {};
		for (let a = 0; a < args.numAttrs; a++) {
			const name = `attr${a}`;
			indexCounts[name] = Tbl.indices[name].getKeysCount();
			let fullScan = 0;
			for (const { value: record } of Tbl.primaryStore.getRange({})) {
				if (record && record[name] === 'v-0') fullScan++;
			}
			let indexed = 0;
			for await (const _ of Tbl.search({ conditions: [{ attribute: name, value: 'v-0' }] })) indexed++;
			searchChecks[name] = { fullScan, indexed, match: fullScan === indexed };
		}

		writeFileSync(
			args.result,
			JSON.stringify(
				{
					completed: true,
					observedStart: observed.start,
					firstKeys: observed.firstKeys,
					visitedThisRun: observed.count,
					primaryCount,
					indexCounts,
					searchChecks,
				},
				null,
				2
			)
		);
		process.exit(0);
	}

	if (args.mode === 'inspect') {
		// Read-only peek: table() may synchronously arm a new indexingOperation (retriggering the
		// backfill is the real production recovery path for a parked/indexingFailed attribute), but
		// runIndexing's body doesn't do any real work until its first `await`. Reading counts and the
		// raw descriptor here, then exiting before that await ever resolves, observes state without
		// letting this process's own inspection contribute any further indexing progress.
		const Tbl = defineTable({ database: args.database, tableName: args.table, numAttrs: args.numAttrs, indexed: true });
		const descriptors = {};
		const prefix = args.table + '/';
		for (const { key, value } of Tbl.dbisDB.getRange({ start: false })) {
			if (!value?.name || !key.toString().startsWith(prefix)) continue;
			if (!value.name.startsWith('attr')) continue;
			descriptors[value.name] = {
				lastIndexedKey: value.lastIndexedKey,
				indexingFailed: value.indexingFailed,
				indexingPID: value.indexingPID,
			};
		}
		const indexCounts = {};
		for (let a = 0; a < args.numAttrs; a++) indexCounts[`attr${a}`] = Tbl.indices[`attr${a}`].getKeysCount();
		writeFileSync(
			args.result,
			JSON.stringify(
				{ inspectedAt: new Date().toISOString(), primaryCount: Tbl.primaryStore.getKeysCount(), indexCounts, descriptors },
				null,
				2
			)
		);
		process.exit(0);
	}

	throw new Error(`unknown mode ${args.mode}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
