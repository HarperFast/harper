'use strict';
// Deliverable B: index-completeness pressure test.
//
// load.js --raw-fraction F writes the trailing F*rows via primaryStore.put() directly, bypassing
// Table.put's updateIndices() -- simulating rows a raw/bulk migration path wrote without going
// through normal index maintenance (and therefore without ever setting index.isIndexing, so
// Harper's crash-recovery/rebuild guard -- which *does* correctly block reads against a
// known-incomplete index, see resources/search.ts:442's `index.isIndexing` check and
// IndexRebuildingError -- never engages; this index looks "done" and isn't).
//
// This script demonstrates the resulting incompleteness and the exact-count comparisons that
// detect it, without needing to run a slow full-key-scan on the query path itself.
const { initEnv } = require('./env.js');
const { defineRedirectTable } = require('./schema.js');

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--db') args.db = argv[++i];
		else if (a === '--status') args.status = argv[++i];
		else if (a === '--host') args.host = argv[++i];
	}
	if (!args.db) throw new Error('--db <path> is required');
	args.status = args.status || 'active';
	args.host = args.host || 'shop.example.com';
	return args;
}

// A true full scan: iterate the primary store directly and filter in JS. Immune to any index
// gap by construction -- this is the ground truth the indexed search is checked against.
function fullScanCount(primaryStore, predicate) {
	let count = 0;
	for (const { value: record } of primaryStore.getRange({})) {
		if (predicate(record)) count++;
	}
	return count;
}

async function indexedCount(Redirect, conditions) {
	let count = 0;
	for await (const _ of Redirect.search({ conditions })) count++;
	return count;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	initEnv(args.db);
	const Redirect = defineRedirectTable();

	// --- detection: exact key counts, index vs primary store -------------------------------
	// Each row indexes exactly one url value and one status value, so under a fully-built index
	// these three counts must be equal. A gap here is detectable offline (e.g. a post-migration
	// health check) without ever running a production query.
	const primaryCount = Redirect.primaryStore.getKeysCount();
	const urlIndexCount = Redirect.indices.url.getKeysCount();
	const statusIndexCount = Redirect.indices.status.getKeysCount();

	// --- demonstration: does an indexed search silently under-return? ----------------------
	const statusFullScan = fullScanCount(Redirect.primaryStore, (r) => r.status === args.status);
	const statusIndexed = await indexedCount(Redirect, [{ attribute: 'status', comparator: 'equals', value: args.status }]);

	const hostPrefix = `https://${args.host}/`;
	const urlFullScan = fullScanCount(Redirect.primaryStore, (r) => typeof r.url === 'string' && r.url.startsWith(hostPrefix));
	const urlIndexed = await indexedCount(Redirect, [{ attribute: 'url', comparator: 'starts_with', value: hostPrefix }]);

	console.log(
		JSON.stringify(
			{
				detection: {
					primaryStoreKeyCount: primaryCount,
					urlIndexKeyCount: urlIndexCount,
					statusIndexKeyCount: statusIndexCount,
					urlIndexGap: primaryCount - urlIndexCount,
					statusIndexGap: primaryCount - statusIndexCount,
					urlIndexIsIndexingFlag: Boolean(Redirect.indices.url.isIndexing),
					statusIndexIsIndexingFlag: Boolean(Redirect.indices.status.isIndexing),
				},
				statusQuery: {
					value: args.status,
					fullScanCount: statusFullScan,
					indexedSearchCount: statusIndexed,
					missingFromIndex: statusFullScan - statusIndexed,
				},
				urlPrefixQuery: {
					prefix: hostPrefix,
					fullScanCount: urlFullScan,
					indexedSearchCount: urlIndexed,
					missingFromIndex: urlFullScan - urlIndexed,
				},
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
