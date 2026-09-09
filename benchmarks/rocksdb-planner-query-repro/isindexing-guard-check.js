'use strict';
// Counter-check: when Harper's own async backfill correctly marks an index in-progress
// (index.isIndexing = true, see resources/databases.ts's runIndexing/reindex bookkeeping), does a
// query against it silently under-return (like the raw-bypass case in completeness.js), or does
// it fail loudly? resources/search.ts:442-453 suggests the latter (IndexRebuildingError). This
// confirms which of the two behaviors actually happens, so the report doesn't conflate "we bypassed
// index maintenance entirely" (silent, completeness.js) with "a normal backfill got interrupted"
// (loud, if this holds).
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

	Redirect.indices.status.isIndexing = true;
	let outcome;
	try {
		let count = 0;
		for await (const _ of Redirect.search({ conditions: [{ attribute: 'status', comparator: 'equals', value: 'active' }] })) {
			count++;
		}
		outcome = { threw: false, count };
	} catch (err) {
		outcome = { threw: true, errorName: err.constructor.name, message: err.message };
	}
	console.log(JSON.stringify(outcome, null, 2));
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
