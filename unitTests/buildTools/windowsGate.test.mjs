// Covers unitTests/windowsGateChecks.mjs. Each case below fails against the calculation it
// replaced: the summary regex was unanchored and first-match, so a "N passing" line a test
// printed itself made a group that never reported an epilogue green; and the timeout
// override was unguarded, so an empty, unparseable, negative or sub-millisecond value
// became setTimeout's 1ms clamp and SIGKILLed every group at spawn.
import assert from 'node:assert';
import { parsePassing, resolveTimeout } from '../windowsGateChecks.mjs';

const DEFAULT_MS = 600_000;
const MAX_MS = 2_147_483_647;

describe('Windows gate summary parsing', function () {
	it('reads the count off a dot-reporter epilogue', function () {
		assert.strictEqual(parsePassing('..........\n\n  13 passing (2s)\n'), '13');
	});

	it('takes the epilogue, not an earlier line a test printed itself', function () {
		const output = '  0 passing is what a broken run reports\n..\n\n  13 passing (2s)\n';
		assert.strictEqual(parsePassing(output), '13');
	});

	it('rejects a summary-shaped fragment mid-line', function () {
		assert.strictEqual(parsePassing('checked that 7 passing rows survived the restart\n'), undefined);
	});

	it('rejects a coloured epilogue, which is why the gate runs mocha with --no-color', function () {
		assert.strictEqual(parsePassing('\u001b[92m \u001b[0m\u001b[32m 13 passing\u001b[0m (2s)\n'), undefined);
	});

	it('reports no summary for a group that died before printing one', function () {
		assert.strictEqual(parsePassing(''), undefined);
		assert.strictEqual(parsePassing('..........\nSegmentation fault\n'), undefined);
	});
});

describe('Windows gate timeout resolution', function () {
	const cases = [
		[undefined, DEFAULT_MS, 'unset'],
		['', DEFAULT_MS, 'empty'],
		['abc', DEFAULT_MS, 'unparseable'],
		['-5', DEFAULT_MS, 'negative'],
		['0', DEFAULT_MS, 'zero'],
		['0.5', DEFAULT_MS, 'sub-millisecond'],
		['0.9999', DEFAULT_MS, 'just under a millisecond'],
		['9999999999', MAX_MS, 'past the 32-bit ceiling'],
		['Infinity', MAX_MS, 'infinite'],
		['5000', 5000, 'a plain override'],
		['5000.7', 5000, 'a fractional override'],
	];

	for (const [envValue, expected, description] of cases) {
		it(`resolves ${description} (${JSON.stringify(envValue)}) to ${expected}ms`, function () {
			assert.strictEqual(resolveTimeout(envValue), expected);
		});
	}

	it('never yields a value setTimeout would clamp to 1ms', function () {
		for (const [envValue] of cases) {
			const ms = resolveTimeout(envValue);
			assert.ok(Number.isInteger(ms) && ms >= 1 && ms <= MAX_MS, `${JSON.stringify(envValue)} resolved to ${ms}`);
		}
	});
});
