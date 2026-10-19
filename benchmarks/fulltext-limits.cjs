const assert = require('node:assert');
const { cpus } = require('node:os');
const {
	DEFAULT_FULL_TEXT_SEARCH_LIMITS,
	resolveFullTextSearchLimits,
} = require('../dist/resources/indexes/fullTextSearchLimits.js');
const populated = structuredClone(DEFAULT_FULL_TEXT_SEARCH_LIMITS);
const iterations = 100000;
const results = [];
for (const [name, value] of [
	['populated', populated],
	['defaults', undefined],
]) {
	let total = 0;
	for (let n = 0; n < 20000; n++) total += resolveFullTextSearchLimits(value).maxCursors;
	const nanoseconds = [];
	for (let run = 0; run < 5; run++) {
		const started = process.hrtime.bigint();
		for (let n = 0; n < iterations; n++) total += resolveFullTextSearchLimits(value).maxCursors;
		nanoseconds.push(Number(process.hrtime.bigint() - started) / iterations);
	}
	assert.strictEqual(total, (20000 + iterations * 5) * DEFAULT_FULL_TEXT_SEARCH_LIMITS.maxCursors);
	results.push({ name, iterationsPerRun: iterations, nanosecondsPerCall: nanoseconds });
}
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0].model, results }, null, 2));
