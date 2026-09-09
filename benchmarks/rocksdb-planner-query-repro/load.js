'use strict';
// Bulk-loads the Redirect table. Batches writes inside explicit transaction() calls so millions
// of rows don't each pay their own commit. Optionally writes a trailing fraction of rows directly
// to primaryStore (bypassing Table.put's index maintenance) to simulate rows a migration/import
// wrote without going through the normal index-update path -- see completeness.js.
const { initEnv } = require('./env.js');
const { defineRedirectTable, makeRandom, generateRow } = require('./schema.js');
const { transaction } = require('#src/resources/transaction');

function parseArgs(argv) {
	const args = { rows: 1000, batch: 5000, rawFraction: 0, seed: 532532 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--db') args.db = argv[++i];
		else if (a === '--rows') args.rows = Number(argv[++i]);
		else if (a === '--batch') args.batch = Number(argv[++i]);
		else if (a === '--raw-fraction') args.rawFraction = Number(argv[++i]);
		else if (a === '--seed') args.seed = Number(argv[++i]);
	}
	if (!args.db) throw new Error('--db <path> is required');
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	initEnv(args.db);
	const Redirect = defineRedirectTable();
	const makeRow = makeRandom(args.seed);
	const rawStartAt = Math.floor(args.rows * (1 - args.rawFraction));

	const start = Date.now();
	let written = 0;
	for (let batchStart = 0; batchStart < args.rows; batchStart += args.batch) {
		const batchEnd = Math.min(batchStart + args.batch, args.rows);
		if (batchStart < rawStartAt) {
			// normal path: goes through Table.put -> index maintenance, batched into one commit
			await transaction(() => {
				for (let i = batchStart; i < Math.min(batchEnd, rawStartAt); i++) {
					Redirect.put(generateRow(i, makeRow));
				}
			});
		}
		if (batchEnd > rawStartAt) {
			// raw path: direct primaryStore write, secondary indices never see these ids
			for (let i = Math.max(batchStart, rawStartAt); i < batchEnd; i++) {
				await Redirect.primaryStore.put(i, generateRow(i, makeRow));
			}
		}
		written = batchEnd;
		if (written % (args.batch * 10) === 0 || written === args.rows) {
			const elapsed = (Date.now() - start) / 1000;
			console.log(`loaded ${written}/${args.rows} rows (${elapsed.toFixed(1)}s, ${(written / elapsed).toFixed(0)} rows/s)`);
		}
	}
	const elapsed = (Date.now() - start) / 1000;
	console.log(
		`done: ${args.rows} rows in ${elapsed.toFixed(1)}s (${(args.rows / elapsed).toFixed(0)} rows/s), ` +
			`raw-bypass rows: [${rawStartAt}, ${args.rows})`
	);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
