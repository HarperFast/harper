# Harper Integration Tests

## Directory Structure

Directory structure mirrors the [Harper v5 reference docs](https://docs.harperdb.io/reference/v5):

| Directory | Coverage |
|---|---|
| `database/` | Schema types, TTL, blob, scale |
| `resources/` | Custom resources, REST API patterns |
| `mqtt/` | MQTT broker, JWT auth, ACL, topic patterns |
| `server/` | Caching (sourcedFrom, SWR), thread management, crash recovery |
| `components/` | Component deployment, lifecycle, fixtures |
| `security/` | TLS, certificates, auth |
| `operations-api/` | Operations API, CLI commands |
| `upgrade/` | v4→v5 upgrade / migration tests |
| `apiTests/` | Legacy bucket — being migrated to the above (see #1215) |

New tests should go in the appropriate subdirectory, not `apiTests/`.

---

This directory contains the integration tests for Harper. They run against the built Harper distribution using the [`@harperfast/integration-testing`](https://github.com/HarperFast/integration-testing-framework) framework and the included Node.js test runner script.

For full background on the testing philosophy, framework APIs, and runner configuration, see the **[`@harperfast/integration-testing` documentation](https://github.com/HarperFast/integration-testing-framework#readme)**. This document covers what is specific to running and writing tests in this repository.

## Setup

### Build Harper

Integration tests require a built distribution of Harper. Run this before executing any tests:

```sh
npm run build
```

### Loopback Addresses

Running tests concurrently requires multiple loopback addresses. Linux systems have these enabled by default; macOS and Windows do not.

```sh
npx harper-integration-test-setup-loopback
```

This script requires `sudo`. Only needs to be run once per machine (or after a restart on macOS).

## Running Tests

Run the full integration test suite:

```sh
npm run test:integration:all
```

Run a specific file or glob pattern:

```sh
npm run test:integration -- "integrationTests/deploy/deploy-from-source.test.ts"
npm run test:integration -- "integrationTests/deploy/*.test.ts"
```

Run sequentially (no loopback pool required — useful for quick debugging):

```sh
npm run test:integration -- --isolation=none integrationTests/**/*.test.ts
# or for a specific file:
npm run test:integration -- --isolation=none "integrationTests/deploy/deploy-from-source.test.ts"
```

### Reproducing a CI Failure

The CI workflow shards tests across multiple runners. If a specific shard fails, you can reproduce it locally by passing the same `--shard` value the job used:

```sh
# Reproduce what "Integration Tests 3/4" ran
npm run test:integration:all -- --shard=3/4
```

### Server Log Capture

To capture Harper's logs during a test run, set `HARPER_INTEGRATION_TEST_LOG_DIR`. Logs from passing suites are cleaned up automatically; only failing suite logs are retained.

```sh
HARPER_INTEGRATION_TEST_LOG_DIR=/tmp/harper-test-logs npm run test:integration:all
```

This is how CI captures logs for failed jobs — the log directory is uploaded as a workflow artifact.

## Writing Tests

### Requirements

- Files must use the Node.js `node:test` API (`suite`, `test`, `before`, `after`, etc.) with assertions from `node:assert/strict`
- Files must end in `.test.ts` or `.test.mjs` (both extensions are picked up by `test:integration:all`)
- Files must be implemented as ESM (TypeScript or JavaScript)
- Each file must begin with a JSDoc comment describing exactly what it tests — include relevant GitHub issue or PR links if they exist
- File names should be short, hyphen-separated words: `install.test.ts`, `application-restart.test.ts`

### File independence

The runner executes each file in its own process. For concurrent execution to be safe, every test file must be **independent** (no shared state with other files), **hermetic** (no external side-effects), and **deterministic** (same output for the same input, every time). See the [framework documentation](https://github.com/HarperFast/integration-testing-framework#testing-ethos) for more on why these properties matter.

### Template

```ts
/**
 * Describe what this file tests.
 * Include as much detail as necessary.
 * Link to relevant GitHub issues or PRs if applicable.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert/strict';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

suite('short description', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('test description', async () => {
		const response = await fetch(ctx.harper.httpURL);
		strictEqual(response.status, 200);
	});
});
```

### Suite-level concurrency

By default, tests within a suite run sequentially. A suite can opt into concurrent test execution with `{ concurrency: true }`, but each individual test within it must then also be independent, hermetic, and deterministic. This is an optional performance optimization, not a requirement.

```ts
suite('concurrent suite', { concurrency: true }, () => {
	test('test a', async () => {
		/* ... */
	});
	test('test b', async () => {
		/* ... */
	});
});
```
