import { run } from 'node:test';
import { availableParallelism } from 'node:os';
import { spec } from 'node:test/reporters';
import { parseArgs } from 'node:util';
import { validateLoopbackAddressPool } from '../loopbackAddressPool.ts';

/**
 * Important! This script should not be required to execute integration tests.
 * Thus, it should not be responsible for any stateful management or setup/teardown logic.
 * All such logic should be contained within the individual test suites or utility functions.
 * Tests (individuals or multiples) should be executable directly via the Node.js Test Runner CLI and
 * parallelization should still work.
 *
 * The main purpose of this script is to reduce the boilerplate required to run integration tests, or having
 * developers manually specify CLI arguments each time.
 *
 * This script configures and runs the Node.js Test Runner with sensible defaults for Harper's integration tests.
 *
 * It supports environment variables to override defaults, allowing flexibility for CI environments or specific use cases.
 */

// Imitating the Node.js Test Runner CLI arguments for consistency except we drop the `test-` prefix
const { values, positionals } = parseArgs({
	options: {
		concurrency: { type: 'string' },
		isolation: { type: 'string' },
		shard: { type: 'string' },
		only: { type: 'boolean' },
	},
	allowPositionals: true,
});

// https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-concurrency
const CONCURRENCY =
	parseInt(process.env.HARPER_INTEGRATION_TEST_CONCURRENCY || values.concurrency, 10) ||
	Math.max(1, Math.floor(availableParallelism() / 2) + 1);
// https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-isolationmode
const ISOLATION = process.env.HARPER_INTEGRATION_TEST_ISOLATION || values.isolation || 'process';
// https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-shard
const [SHARD_INDEX, SHARD_TOTAL] = (process.env.HARPER_INTEGRATION_TEST_SHARD || values.shard || '1/1')
	.split('/')
	.map((v) => parseInt(v, 10));
// https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-only
const ONLY = parseBoolean(process.env.HARPER_INTEGRATION_TEST_ONLY) ?? values.only ?? false;

const TEST_FILES =
	positionals.length > 0
		? positionals
		: [
				'integrationTests/**/*.test.ts', // match all TS test files in the integrationTests directory
				'!apiTests/**/*', // exclude apiTests directory as those tests are not meant to be run individually
			];

// Loopback Address Check
if (ISOLATION !== 'none' && CONCURRENCY > 1) {
	const result = await validateLoopbackAddressPool();
	if (result.failed.length > 0) {
		console.error('Failed to bind loopback address pool required for integration tests:');
		for (const failure of result.failed) {
			console.error(`- ${failure.loopbackAddress}: ${failure.error.message}`);
		}
		console.error(
			'Refer to the Harper Integration Test documentation (integrationTests/README.md) for more information.'
		);
		console.error('Or run integration tests sequentially using `--isolation=none` to avoid this requirement.');
		process.exit(1);
	}
}

run({
	concurrency: ISOLATION === 'none' ? undefined : CONCURRENCY,
	// @ts-expect-error - ignore until we do better env var / cli arg handling/validation
	isolation: ISOLATION,
	globPatterns: TEST_FILES,
	only: ONLY,
	shard: {
		index: SHARD_INDEX,
		total: SHARD_TOTAL,
	},
})
	.on('test:fail', () => {
		process.exitCode = 1;
	})
	.compose(spec)
	.pipe(process.stdout);

function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (value.toLowerCase() === 'true' || value === '1') return true;
	if (value.toLowerCase() === 'false' || value === '0') return false;
	return undefined;
}
