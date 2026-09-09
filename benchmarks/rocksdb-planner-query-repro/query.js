'use strict';
// Runs one multi-condition AND query against an already-loaded Redirect table and reports:
//  - the planner's chosen condition order + per-condition estimated_count (via explain:true,
//    which Table.search returns synchronously before executing anything -- Table.ts ~3660)
//  - primaryStore.readCount delta across the real (non-explain) execution
//  - wall-clock time for planning+execution
// Each invocation is a fresh process, so RocksDatabase's 10s estimatedEntryCount cache
// (resources/search.ts's estimatedEntryCountExpires) is always cold -- matching a first-query-of-
// the-connection-pool-lifetime customer scenario, not a warmed-up steady state.
const { initEnv } = require('./env.js');
const { defineRedirectTable, makeRandom, generateRow } = require('./schema.js');

function parseArgs(argv) {
	const args = { query: 'equals', enforceExecutionOrder: false, id: 1, seed: 532532 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--db') args.db = argv[++i];
		else if (a === '--query') args.query = argv[++i];
		else if (a === '--enforce-execution-order') args.enforceExecutionOrder = true;
		else if (a === '--host') args.host = argv[++i];
		else if (a === '--status') args.status = argv[++i];
		else if (a === '--id') args.id = Number(argv[++i]);
		else if (a === '--seed') args.seed = Number(argv[++i]);
	}
	if (!args.db) throw new Error('--db <path> is required');
	return args;
}

function buildConditions(query, host, status, existingUrl) {
	const urlPrefix = `https://${host || 'shop.example.com'}/`;
	if (query === 'equals') {
		return [
			{ attribute: 'url', comparator: 'equals', value: existingUrl ?? `${urlPrefix}r/1/999999` },
			{ attribute: 'status', comparator: 'equals', value: status },
		];
	}
	if (query === 'startswith') {
		return [
			{ attribute: 'url', comparator: 'starts_with', value: urlPrefix },
			{ attribute: 'status', comparator: 'equals', value: status },
		];
	}
	throw new Error(`unknown --query ${query}`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	initEnv(args.db);
	const Redirect = defineRedirectTable();
	// A real, known-to-exist row for the equals case (rather than a guaranteed-miss value), so
	// resultCount reflects an actual hit.
	const targetRow = generateRow(args.id, makeRandom(args.seed));
	const status = args.status ?? targetRow.status;
	const host = args.host ?? new URL(targetRow.url).host;

	// Table.search mutates its conditions array/objects in place (coercion, chaining, cached
	// estimated_count), so explain and the real execution each need their own fresh copy.
	const t0 = Date.now();
	const explanation = Redirect.search({
		conditions: buildConditions(args.query, host, status, targetRow.url),
		explain: true,
		enforceExecutionOrder: args.enforceExecutionOrder,
	});
	const tExplain = Date.now();

	const readCountBefore = Redirect.primaryStore.readCount;
	let resultCount = 0;
	for await (const record of Redirect.search({
		conditions: buildConditions(args.query, host, status, targetRow.url),
		enforceExecutionOrder: args.enforceExecutionOrder,
	})) {
		resultCount++;
	}
	const tExec = Date.now();
	const readCountAfter = Redirect.primaryStore.readCount;

	console.log(
		JSON.stringify(
			{
				query: args.query,
				enforceExecutionOrder: args.enforceExecutionOrder,
				plannedOrder: explanation.conditions.map((c) => ({
					attribute: c.attribute ?? c[0],
					comparator: c.comparator ?? c.search_type,
					estimated_count: c.estimated_count,
				})),
				explainMs: tExplain - t0,
				execMs: tExec - tExplain,
				totalMs: tExec - t0,
				readCountDelta: readCountAfter - readCountBefore,
				resultCount,
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
