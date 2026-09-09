'use strict';
// Isolates the exact change in commit 7acf00888 (resources/search.ts's estimatedEntryCount):
// RocksDatabase.getKeysCount() (full key scan) vs getEstimatedKeyCount() (O(1) estimate-num-keys).
// Bypasses the query layer entirely so this measurement isn't mixed with unrelated per-value
// index-count costs (e.g. index.getValuesCount('active') for a low-selectivity value, which is
// untouched by #2163 and costs the same on both sides of the fix).
const { initEnv } = require('./env.js');
const { defineRedirectTable } = require('./schema.js');

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--db') args.db = argv[++i];
	}
	if (!args.db) throw new Error('--db <path> is required');
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	initEnv(args.db);
	const Redirect = defineRedirectTable();
	const store = Redirect.primaryStore;

	const t0 = Date.now();
	const exactCount = store.getKeysCount(); // pre-#2163 code path (full scan)
	const t1 = Date.now();
	const estimatedCount =
		typeof store.getEstimatedKeyCount === 'function' ? store.getEstimatedKeyCount() : undefined; // post-#2163 code path (O(1))
	const t2 = Date.now();

	console.log(
		JSON.stringify(
			{
				exactCount,
				getKeysCountMs: t1 - t0,
				estimatedCount,
				getEstimatedKeyCountMs: t2 - t1,
			},
			null,
			2
		)
	);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
