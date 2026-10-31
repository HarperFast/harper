const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');
const { performance } = require('node:perf_hooks');
const { compareKeys } = require('ordered-binary');
const { convertToComparableKeys } = require('#src/resources/Resource');
const { table } = require('#src/resources/databases');
const { setupTestDBPath } = require('../unitTests/testUtils');

const source = fs.readFileSync(path.join(__dirname, '../resources/Table.ts'), 'utf8');
const getterStart = source.indexOf('\tfunction getAttributeValue(');
const getterEnd = source.indexOf('\n\tfunction getPathValue(', getterStart);
const sortStart = source.indexOf(
	'\t\treturn (entries: FullTextSearchEntry[]) => {',
	source.indexOf('function fullTextResultOrder')
);
const sortEnd = source.indexOf('\n\t}\n\n\tfunction assertFullTextReadAccess', sortStart);
assert(
	getterStart >= 0 && getterEnd > getterStart && sortStart >= 0 && sortEnd > sortStart,
	'production closures moved; update the extraction'
);
const getterSource = source.slice(getterStart, getterEnd);
const sortSource = source.slice(sortStart, sortEnd);
const unavailablePath = () => {
	throw new Error('This cost observation supports directly stored scalar fields only');
};
// Extract the production closures so the observation cannot silently time a copied implementation.
const makeGetter = new Function(
	'primaryStore',
	'propertyResolvers',
	'getPathValue',
	`${stripTypeScriptTypes(getterSource)}\nreturn getAttributeValue`
);
const makeSorter = new Function(
	'clauses',
	'getAttributeValue',
	'convertToComparableKeys',
	'compareKeys',
	'context',
	`${stripTypeScriptTypes(`function factory() { ${sortSource} }`)}\nreturn factory()`
);
const report = {
	node: process.version,
	cpu: os.cpus()[0].model,
	rows: 10000,
	warmups: 3,
	samples: 30,
	closureSha256: createHash('sha256').update(getterSource).update(sortSource).digest('hex'),
	scope:
		'Production getAttributeValue and decorated-key sort closures with real Table scalar property resolvers and resident record entries. Excludes native retrieval, source-version checks, projection, highlighting, GC isolation and end-to-end latency.',
	cases: [],
};

describe('full-text stored scalar sort cost observation', () => {
	before(() => setupTestDBPath());
	for (const width of [1, 3, 32]) {
		it(`${width} clauses over 10000 resident entries`, () => {
			const clauses = Array.from({ length: width }, (_, index) => ({ attribute: `key${index}`, descending: false }));
			const Scalar = table({
				database: 'fulltext-sort-cost',
				table: `Scalar${width}`,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					...clauses.map((clause, index) => ({ name: clause.attribute, type: index < width - 1 ? 'String' : 'Float' })),
				],
			});
			const getter = makeGetter(Scalar.primaryStore, Scalar.propertyResolvers, unavailablePath);
			const sorter = makeSorter(clauses, getter, convertToComparableKeys, compareKeys, undefined);
			const entries = Array.from({ length: report.rows }, (_, index) => ({
				recordEntry: {
					value: Object.fromEntries(
						clauses.map((clause, column) => [
							clause.attribute,
							column < width - 1 ? 'shared' : (index * 7919) % report.rows,
						])
					),
				},
			}));
			const elapsed = [];
			for (let run = 0; run < report.warmups + report.samples; run++) {
				const copy = entries.slice();
				const started = performance.now();
				sorter(copy);
				const milliseconds = performance.now() - started;
				if (run >= report.warmups) elapsed.push(milliseconds);
				assert.strictEqual(copy[0].recordEntry.value[`key${width - 1}`], 0);
				assert.strictEqual(copy.at(-1).recordEntry.value[`key${width - 1}`], report.rows - 1);
			}
			const ranked = elapsed.slice().sort((left, right) => left - right);
			report.cases.push({
				clauses: width,
				leadingTiedKeys: width - 1,
				milliseconds: elapsed,
				p50Milliseconds: (ranked[14] + ranked[15]) / 2,
				p95Milliseconds: ranked[28],
				maxMilliseconds: ranked[29],
			});
		});
	}
	after(() => {
		assert.strictEqual(report.cases.length, 3, 'All cost cases must complete before publishing samples');
		const json = JSON.stringify(report, null, 2) + '\n';
		if (process.env.FULLTEXT_SORT_COST_REPORT) fs.writeFileSync(process.env.FULLTEXT_SORT_COST_REPORT, json);
		console.log(json);
	});
});
