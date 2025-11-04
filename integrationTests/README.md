# Harper Integration Tests

We prioritize performance at Harper, and that extends to core developer experience and productivity. Harper is a significantly complex application involving multiple processes, threads, file I/O, database operations, network calls, and so much more. Integration tests differ from unit test as they **must run against the built distribution of Harper as if it was a user or another system** (instead of importing source/built code directly). As a result, integration tests will be as resource intensive as the Harper system is.

In order to keep things as fast as possible, integration test **files** must be:

- **Independent**: Test files do not depend on execution order or state from other test files
- **Hermetic**: Test files are self-contained with no external side-effects
- **Deterministic**: The same input always produces the same output, no matter how many times its executed

If we follow these guidelines strictly, we can execute integration tests concurrently, minimizing the amount of time a developer must wait for tests to verify their code changes. Inevitably when a code change breaks a test, a developer should be able to execute at least that test file in isolation in order to iterate on the necessary fix as quickly as possible.

## Note on `integrationTests/apiTests`

This directory contains integration tests migrated from our old repository. These test are incredibly important and are one of the most important ways we've verified the Harper application continues to work throughout the open source transfer. Unfortunately, these tests are very interdependent and cannot be run separately from each other. The setup in early test files is necessary for most other test files to work, and some tests (spread across multiple files) interact with the same resources and data and in some circumstances must be executed in a certain order. This interdependence has made it very difficult, if not impossible, for developers to isolated failing tests during development.

These tests should be generally excluded from our new integration testing guidelines while they are actively ported to new implementations. They are automatically ignored by the `test:integration` script, and can be executed using the `test:integration:api-tests` npm script instead.

These tests have their own unique configuration and setup requirements that differ from the newer integration test guidelines.

## Running Tests

> [!IMPORTANT]
> Running Harper integration tests concurrently requires enabling loopback addresses.
>
> Linux Ubuntu systems generally have 127.0.0.1 - 127.255.255.255 enabled by default, but MacOS and Windows does not.
>
> Use the included script `integrationTests/utils/scripts/setup-loopback.sh` to quickly enable the required set of loopback addresses.
>
> This script does require `sudo` permissions. We recommend reviewing the source before executing.
>
> The script respects the `HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT` environment variable (defaults to 32) to configure the number of loopback addresses. The integration test runner will automatically validate that the required loopback addresses are available before running tests and will exit with an error if they are not configured.

The Node.js test runner uses process isolation to run test files concurrently _by default_. Meaning, `node --test "integrationTests/*.test.mts"` will run every matched file in its own process. Node.js determines the number of concurrent processes using `os.availableParallelism() - 1`. Since Harper is itself a resource intensive application, this default concurrency causes extreme resource contention and system thrashing as each integration test file is also running at least one more process, the Harper application, plus whatever additional work the Harper application does as part of the tests. Through deep analysis, we have determine a safer default concurrency for our circumstances is slightly more than half of the available parallelism. For more information see [Node.js Test Runner Parallelization Analysis](https://github.com/Ethan-Arrowood/node-test-runner-parallelization-analysis). Thus, using `node --test` to run _all_ integration tests is insufficient. We include a npm script `test:integration` for simplified execution. The `node --test` command can still be used to run an individual test file, or at most a small set of test files, but we recommend using `test:integration` whenever possible.

The `test:integration` script will execute **all integration tests by default** using the safe concurrency settings as described above. Integration tests require a built version of Harper, make sure to run `npm run build` before continuing.

For example:

```sh
npm run test:integration
```

> The `test:integration` script excludes executing `integrationTests/apiTests` as they are not compatible with the concurrent nature of new integration tests. For more information see [Note on `integrationTests/apiTests`](#note-on-integrationtestsapitests).

The script accepts [additional options](#available-options) via CLI arguments, and one or more glob patterns can be provided as the final argument(s) to specify exact test files to execute.

For example:

```sh
# Supports exact file paths
npm run test:integration -- "integrationTests/deploy/deploy-from-source.test.mts"
# Or glob patterns
npm run test:integration -- "integrationTests/deploy/*.test.mts"
# Or multiple entries
npm run test:integration -- "integrationTests/deploy/deploy-from-source.test.mts" "integrationTests/deploy/deploy-from-github.test.mts"
```

### Available options:

All CLI arguments can be overridden using the associative `HARPER_INTEGRATION_TEST_*` environment variable where the `*` is replaced by the capitalized CLI argument name. For example, `--concurrency` is replaced by `HARPER_INTEGRATION_TEST_CONCURRENCY`.

Configuration precedence order is:

1. Environment Variables
2. CLI Argument
3. Default Value

#### `--concurrency=number`

> Equivalent to Node.js Test Runner's [`--test-concurrency`](https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-concurrency) option.

Set the exact amount of processes that should be used to execute test files.

Must be an integer greater than `0`.

Use `1` to run all tests sequentially in a separate process from the test runner itself.

Use any number greater than 1 to run tests concurrently on that many processes.

This option is ignored when `--isolation=none` is set.

For example:

```sh
# Concurrently
npm run test:integration -- --concurrency=7
```

This option can be overridden using the `HARPER_INTEGRATION_TEST_CONCURRENCY` environment variable.

#### `--isolation=mode`

> Equivalent to Node.js Test Runner's [`--test-isolation=mode`](https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-isolationmode) option.

Valid options for `mode` is `none` or `process`. Defaults to `process`.

When set to `none`, the `--concurrency` option is ignored and all tests are executed sequentially in the main test runner process.

This option can be overridden using the `HARPER_INTEGRATION_TEST_ISOLATION` environment variable.

#### `--shard=index/total`

> Equivalent to Node.js Test Runner's [`--test-shard`](https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-shard) option.

The input should be two integer numbers separated by a `/` character. Keep the `total` value the same (as well as the test file inputs) and you can deterministically iterate through the shards by incrementing the `index` value.

For example, each of these four commands will always run the exact same subset of test files.

```
npm run test:integration -- --shard=1/4
npm run test:integration -- --shard=2/4
npm run test:integration -- --shard=3/4
npm run test:integration -- --shard=4/4
```

This option is used by the CI workflow and is useful for executing the same subset of test files as a specific runner did. For example, if the "Integration Tests 3/4 (Node.js v24)" job failed, you can use `npm run test:integration -- --shard=3/4` on Node.js v24 to run the exact same set of test files the CI job did!

This option can be overridden using the `HARPER_INTEGRATION_TEST_SHARD` environment variable.

#### `--only`

> Equivalent to Node.js Test Runner's [`--test-only`](https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-only) option.

Execute tests with the `only` option set. Such as `test.only(/* ... */)` or `test('...', { only: true }, /* ... */)`

This option can be overridden using the `HARPER_INTEGRATION_TEST_ONLY` environment variable and using values `true` or `1` to enable, or `false` or `0` to disable.

## Writing Tests

As mentioned in the introduction, integration test **files** should be **independent**, **hermetic**, and **deterministic**.

All files meant to be executed by the test runner should end in `.test.mts` (ES module TypeScript). They can be nested within directories for organization purposes, or be top-level in this `integrationTests` directory. Every test file should begin with a comment block explaining exactly what it is meant to test.

Tests must use the Node.js Test Runner API [`node:test`]() for establishing suites (`describe` or `suite`), tests (`it` or `test`), and lifecycle methods (`before`, `beforeEach`, `after`, and `afterEach`).

The test runner API enables many different ways to write tests. While we don't enforce or restrict a certain pattern, it is important to understand how they are executed. Within a test file can be **suites**, **tests**, and **lifecycle methods**. These all can be top-level or nested. Execution follows the logical order and scoping of the file. Our _recommendation_ is to utilize `suite()` with nested `test()` calls to organize tests.

There can be multiple suites within a test file. They are always executed sequentially. Tests run sequentially by default, but a suite can be configured with the `{ concurrency: true }` option to run tests concurrently within that test process. For a naive demo of this in action see the [Suite Concurrency Example](#suite-concurrency-example).

As previously mentioned, individual test files should be fully independent for the purpose of parallelization. Due to the complexity of Harper and many testing scenarios, we only require each test **file** to be independent, hermetic, and deterministic. In some circumstances, suite-level concurrency is another great way to improve the performance of tests, but now each individual **test** within the suite must be independent, hermetic, and deterministic. This level of optimization is simply a bonus, and not a requirement.

Furthermore, tests must also use the Node.js assert module in strict mode [`node:assert/strict`]() for all test assertions.

Since these tests interact with a running Harper instance directly, they often will need to validate actual application output. Common examples of this include:

- Standard Streams (`stdout`/`stderr`)
- Network Responses
- File System

Reusable assertion patterns will develop over time. Familiarize yourself with existing tests and the [Integration Test Utilities documentation](./utils/README.md) to best understand general testing patterns.

### Utilities

Integration test utilities are located in the [`integrationTests/utils/`](./utils/) directory and provide essential functionality for test setup, teardown, and common operations.

**Complete utilities documentation is available at [`integrationTests/utils/README.md`](./utils/README.md).**

#### Quick Reference

The most commonly used utilities are:

- **`setupHarper(context)`** - Sets up a complete Harper instance for testing. Use in `before()` hooks.
- **`teardownHarper(context)`** - Tears down a Harper instance and cleans up resources. Use in `after()` hooks.
- **`ContextWithHarper`** - TypeScript interface for test context with Harper instance details.
- **`targz(dirPath)`** - Compresses a directory into a base64-encoded tar.gz string for application deployment.

**Example usage:**

```ts
import { suite, test, before, after } from 'node:test';
import { setupHarper, teardownHarper, type ContextWithHarper } from './utils/harperLifecycle.mts';

suite('test suite', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('make a request', async () => {
		const response = await fetch(ctx.harper.httpURL);
		// ... assertions
	});
});
```

**For detailed documentation** including all available utilities, parameters, return types, configuration options, and advanced usage examples, see the [**Integration Test Utilities Documentation**](./utils/README.md).

### Test File Template

Create a new file with a short, descriptive name ending with `.test.mts`. Separate words using `-`. Its generally best to use 1 to 3 words such as `install.test.mts` or `application-management-installation.test.mts`.

Copy and paste the following content to get started:

```ts
/**
 * Complete description of this test file.
 * Include as much detail as possible.
 * Include relevant GitHub issue and PR links if they exist.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual } from 'node:assert/strict';
// Note: adjust the relative path accordingly (e.g., '../utils/harperLifecycle.mts')
import { setupHarper, teardownHarper, type ContextWithHarper } from './utils/harperLifecycle.mts';

suite('short description of tests', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('test description', async () => {
		// Use `ctx.harper` for access to the instance
		// Example: const response = await fetch(ctx.harper.httpURL);
	});
});
```

### Suite Concurrency Example

For example, this example file contains **two suites** containing **two tests** each. The first suite has concurrency enabled with `{ concurrency: true }`, and the second does not. Each of the four tests simply wait 1 second before resolving and passing.

_How long do you expect this test file to execute?_

```ts
import { suite, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

suite('Concurrency Enabled', { concurrency: true }, () => {
	test('1 second', async () => {
		await sleep(1000);
	});

	test('1 second', async () => {
		await sleep(1000);
	});
});

suite('Concurrency Disabled', () => {
	test('1 second', async () => {
		await sleep(1000);
	});

	test('1 second', async () => {
		await sleep(1000);
	});
});
```

- The first suite's tests run concurrently resulting in an ~1 second of total run time
- The second suite's tests run sequentially resulting in ~2 seconds of total run time
- Suites always run sequentially so the **total run time for the file is ~3 seconds**

```
❯ node --test example.test.ts
▶ Concurrency Enabled
  ✔ 1 second (1001.359083ms)
  ✔ 1 second (1001.860375ms)
✔ Concurrency Enabled (1002.26125ms)
▶ Concurrency Disabled
  ✔ 1 second (1001.122166ms)
  ✔ 1 second (1000.5495ms)
✔ Concurrency Disabled (2001.850625ms)
ℹ tests 4
ℹ suites 2
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3087.786041
```

## GitHub Actions Workflow Parallelization

It is equally important for integration tests to run efficiently and reliably on CI systems; in our case GitHub Actions. As the amount of integration test files increases, so does the need for more or smarter parallelization strategies. Further compounded by the need to verify additional operating systems and Node.js versions, a collection of even just 10 integration test files quickly becomes a very large CI operation. The goal is to use CI workflow strategies that strikes a fine balance between cost and efficiency. Tests should always run reliably; thus, never compromising correctness for the sake of efficiency. Overloaded systems can cause test failures as machines cannot handle the sheer volume of work.

The default GitHub Actions runners have limited performance capabilities. While they can reasonably handle an individual integration test, parallelizing multiple of them will generally exceed the runner's capabilities. As a result, our primary strategy is to parallelize across multiple runners using workflow matrix jobs. We also have the option to use larger runners, but these come with a serious increase in cost. The trade off comes down to the amount of CI jobs happening within the Harper organization. Parallel job execution is limited at the organization level across all repositories. Thus, at some volume of jobs across the entire organization, the time spent waiting for available runners will exceed the time saved by parallelizing jobs. At that point, we should consider reducing job parallelization in favor of using large runners, and switch to parallelization on the runner itself akin to our local development experience.

Furthermore, we should be smart about the amount of parallel jobs are created for any given workflow event. If we ran every integration test across all 3 Node.js versions we support, on every single commit on every single open PR... we very, very quickly would reach the limits. By leveraging test sharding, file path filter triggers, and manually triggered workflows, we can ensure that the workflow only runs when absolutely necessary.

As future work, we should consider implementing a merge queue for PRs. This merge queue can be responsible for running the integration tests across multiple Node.js versions and operating systems _after_ the PR has passed initial checks (such as a single Node.js version on a single operating system). This would allow for faster PR iteration while still maintaining a thoroughly tested `main` branch.
