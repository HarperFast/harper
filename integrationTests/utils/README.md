# Integration Test Utilities

This directory contains utility functions and modules for Harper integration tests. These utilities provide common functionality for setting up test environments, managing Harper instances, and performing test-related operations.

## Table of Contents

- [Integration Test Utilities](#integration-test-utilities)
  - [Table of Contents](#table-of-contents)
  - [Harper Lifecycle Management](#harper-lifecycle-management)
    - [`startHarper(context, options?): Promise<ContextWithHarper>`](#startharpercontext-options-promisecontextwithharper)
    - [`StartHarperOptions`](#startharperoptions)
    - [`killHarper(context): Promise<void>`](#killharpercontext-promisevoid)
    - [`teardownHarper(context): Promise<void>`](#teardownharpercontext-promisevoid)
    - [`ContextWithHarper`](#contextwithharper)
  - [Loopback Address Pool](#loopback-address-pool)
    - [`validateLoopbackAddressPool(): Promise<ValidationResult>`](#validateloopbackaddresspool-promisevalidationresult)
    - [`getNextAvailableLoopbackAddress(): Promise<string>`](#getnextavailableloopbackaddress-promisestring)
    - [`releaseLoopbackAddress(address: string): Promise<void>`](#releaseloopbackaddressaddress-string-promisevoid)
    - [`releaseAllLoopbackAddressesForCurrentProcess(): Promise<void>`](#releaseallloopbackaddressesforcurrentprocess-promisevoid)
  - [Compression Utilities](#compression-utilities)
    - [`targz(dirPath: string): Promise<string>`](#targzdirpath-string-promisestring)
  - [Scripts](#scripts)
    - [`scripts/setup-loopback.sh`](#scriptssetup-loopbacksh)
    - [`scripts/run.mts`](#scriptsrunmts)

---

## Harper Lifecycle Management

**Module:** [`harperLifecycle.ts`](./harperLifecycle.ts)

Provides functions for managing Harper instances during integration tests, including installation, startup, and teardown.

### `startHarper(context, options?): Promise<ContextWithHarper>`

Sets up a complete Harper instance for testing.

**Parameters:**

- `context` - [`ContextWithHarper`](#contextwithharper) - The test context object
- `options` - [`StartHarperOptions`](#startharperoptions) (optional) - Configuration options for the setup process

**Returns:** `Promise<ContextWithHarper>` - The context with the `harper` property populated

**Description:**

This method should be used in the `before()` lifecycle hook for a test suite. It performs the following steps:

1. Creates a Harper instance in a temporary directory (reuses `ctx.harper.installDir` if already set)
2. Assigns a unique loopback address from the loopback address pool (reuses `ctx.harper.hostname` if already set)
3. Starts Harper with test configuration (which self-installs)
4. Waits for Harper to be fully started, waiting for the startup message to appear in stdout
5. Populates the `context.harper` object with connection details

**Important:** Always call `teardownHarper(ctx)` in the `after()` hook to properly clean up resources, or you will have phantom Harper processes after tests complete.

**Examples:**

```ts
import { suite, test, before, after } from 'node:test';
import { startHarper, teardownHarper, type ContextWithHarper } from '../utils/harperLifecycle.ts';

// Default setup
suite('My test suite', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('can make request to Harper', async () => {
		const response = await fetch(ctx.harper.httpURL);
		// ... assertions
	});
});
```

---

### `StartHarperOptions`

Configuration options for `startHarper()`.

```typescript
export interface StartHarperOptions {
	startupTimeoutMs?: number;
	config: any;
	env: any;
}
```

**Properties:**

- **`config`** - `object` - Additional configuration options to pass to the Harper CLI.
- **`env`** - `object` - Additional environment variables to set when starting Harper.
- **`startupTimeoutMs`** - `number` (optional) - Timeout in milliseconds to wait for Harper to start. Defaults to 30000, or the value of the `HARPER_INTEGRATION_TEST_STARTUP_TIMEOUT_MS` environment variable if set.

**Environment Variables:**

- `HARPER_INTEGRATION_TEST_STARTUP_TIMEOUT_MS` - Sets the default startup timeout for all tests when `startupTimeoutMs` is not explicitly provided
- `HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR` - Override the parent directory for Harper installation directories (defaults to the OS temp directory)
- `HARPER_INTEGRATION_TEST_INSTALL_SCRIPT` - Override the path to the Harper CLI script (defaults to `dist/bin/harper.js` relative to the repo root)
- `HARPER_INTEGRATION_TEST_LOG_DIR` - When set, stdout/stderr logs and Harper's `hdb.log` are written to per-suite subdirectories here; logs are deleted automatically on successful exit and retained on failure

---

### `killHarper(context): Promise<void>`

Kills the running Harper process. Does **not** release the loopback address or remove the installation directory.

**Parameters:**

- `context` - [`ContextWithHarper`](#contextwithharper) - The test context with a running Harper instance

**Returns:** `Promise<void>`

**Description:**

Sends `SIGTERM` to the Harper process and waits for it to exit. If the process does not exit within 200ms, `SIGKILL` is sent.

This is useful for testing Harper restart/crash scenarios. After calling `killHarper()`, call `startHarper()` to restart the instance in the same directory with the same loopback address.

**Example:**

```ts
test('recovers after restart', async () => {
	await killHarper(ctx);
	await startHarper(ctx);
	// Harper is running again on the same address
});
```

---

### `teardownHarper(context): Promise<void>`

Tears down a Harper instance and cleans up all resources.

**Parameters:**

- `context` - [`ContextWithHarper`](#contextwithharper) - The test context with Harper instance details

**Returns:** `Promise<void>`

**Description:**

This method should be used in the `after()` lifecycle hook in conjunction with `startHarper()` and `before()`. It performs the following cleanup steps:

1. Stops the Harper instance
2. Releases the loopback address back to the pool
3. Removes the Harper installation directory from the filesystem

**Example:**

```ts
suite('My test suite', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ... tests
});
```

---

### `ContextWithHarper`

TypeScript interface that extends `SuiteContext` and `TestContext` from Node.js test runner.

**Interface Definition:**

```typescript
export interface HarperContext {
	dataRootDir: string;
	admin: {
		username: string;
		password: string;
	};
	httpURL: string;
	operationsAPIURL: string;
	hostname: string;
	process: ChildProcess;
	logDir?: string;
}

export interface ContextWithHarper extends SuiteContext, TestContext {
	harper: HarperContext;
}
```

**Properties:**

- **`harper`** - `HarperContext` - The Harper instance details
  - **`dataRootDir`** - `string` - The absolute path to the Harper installation directory
  - **`admin`** - `object` - Admin credentials
    - **`username`** - `string` - The Harper Admin Username (default: `'admin'`)
    - **`password`** - `string` - The Harper Admin Password (default: `'Abc1234!'`)
  - **`httpURL`** - `string` - The HTTP URL for the Harper instance (e.g., `'http://127.0.0.2:9926'`)
  - **`operationsAPIURL`** - `string` - The Operations API URL (e.g., `'http://127.0.0.2:9925'`)
  - **`hostname`** - `string` - The assigned loopback IP address (e.g., `'127.0.0.2'`)
  - **`process`** - `ChildProcess` - The Node.js child process handle for the running Harper instance
  - **`logDir`** - `string | undefined` - Absolute path to the per-suite log directory; only set when `HARPER_INTEGRATION_TEST_LOG_DIR` is configured

**Example Usage:**

```ts
test('authenticate with admin credentials', async () => {
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${btoa(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`)}`,
		},
		body: JSON.stringify({ operation: 'describe_all' }),
	});
	// ... assertions
});
```

---

## Loopback Address Pool

**Module:** [`loopbackAddressPool.ts`](./loopbackAddressPool.ts)

Manages a pool of loopback addresses for concurrent test execution. This allows multiple Harper instances to run simultaneously on different loopback addresses without port conflicts.

### `validateLoopbackAddressPool(): Promise<ValidationResult>`

Validates that all loopback addresses in the pool can be bound to.

**Returns:** `Promise<{ successful: string[], failed: { loopbackAddress: string, error: Error }[] }>`

**Description:**

This function attempts to bind to each loopback address in the pool (127.0.0.1 through 127.0.0.32 by default) to verify they are available. It returns arrays of successful and failed addresses.

This is automatically called by the integration test runner script before executing tests. If any addresses fail to bind, the test runner will exit with an error and provide instructions for setting up loopback addresses.

**Environment Variables:**

- `HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT` - Number of loopback addresses to validate (1-255, default: 32)

**Example:**

```ts
const result = await validateLoopbackAddressPool();
console.log(`Successfully validated ${result.successful.length} addresses`);
if (result.failed.length > 0) {
	console.error('Failed addresses:', result.failed);
}
```

---

### `getNextAvailableLoopbackAddress(): Promise<string>`

Retrieves the next available loopback address from the pool using a file-based locking mechanism to safely allocate addresses across concurrent test processes.

**Returns:** `Promise<string>` - A loopback IP address (e.g., `'127.0.0.2'`)

**How it works:**

1. Acquires a file-based lock to prevent race conditions with other processes
2. Reads the pool state (a JSON array of process IDs, with null for available slots)
3. Finds the first available (null) slot and assigns the current process PID to it
4. Writes the updated pool back to disk and releases the lock
5. Validates that the allocated address can actually be bound to
6. Returns the loopback address

If no addresses are available, the function waits and retries until one becomes available.

**Pool file location:** `${tmpdir()}/harper-integration-test-loopback-pool.json`
**Lock file location:** `${tmpdir()}/harper-integration-test-loopback-pool.lock`

**Note:** This is automatically called by `startHarper()`. You typically don't need to call this directly unless you're implementing custom test infrastructure.

---

### `releaseLoopbackAddress(address: string): Promise<void>`

Releases a loopback address back to the pool.

**Parameters:**

- `address` - `string` - The loopback address to release (e.g., `'127.0.0.2'`)

**Returns:** `Promise<void>`

**Note:** This is automatically called by `teardownHarper()`. You typically don't need to call this directly unless you're implementing custom test infrastructure.

---

### `releaseAllLoopbackAddressesForCurrentProcess(): Promise<void>`

Releases all loopback addresses assigned to the current process.

**Returns:** `Promise<void>`

**Description:**

This function scans the loopback pool and releases all addresses that are currently assigned to the calling process (based on process PID). This is useful for cleanup during graceful shutdown or error handling scenarios where you want to ensure all resources are released.

**Use Cases:**

- Cleanup in process exit handlers
- Error recovery when a test suite fails before proper teardown
- Bulk cleanup in test infrastructure code

**Example:**

```ts
// Register cleanup on process exit
process.on('exit', async () => {
	await releaseAllLoopbackAddressesForCurrentProcess();
});

// Or use in error handling
try {
	await runTests();
} catch (error) {
	console.error('Tests failed:', error);
	await releaseAllLoopbackAddressesForCurrentProcess();
	throw error;
}
```

**Note:** While `teardownHarper()` releases individual addresses, this function provides a safety net for cases where teardown might not execute properly.

---

## Compression Utilities

**Module:** [`targz.ts`](./targz.ts)

Provides utilities for compressing directories into tar.gz archives.

### `targz(dirPath: string): Promise<string>`

Packs and compresses a directory into a base64-encoded tar.gz string.

**Parameters:**

- `dirPath` - `string` - Absolute path to the directory to pack and compress

**Returns:** `Promise<string>` - A base64-encoded string containing the compressed tar.gz archive

**Description:**

This utility is particularly useful for deploying applications via the Operations API, which accepts base64-encoded tar.gz payloads for the `deploy_component` operation.

**Example:**

```ts
import { targz } from '../utils/targz.mts';
import { join } from 'node:path';

test('deploy application from source', async () => {
	const appDirectory = join(import.meta.dirname, 'fixture');
	const payload = await targz(appDirectory);

	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			operation: 'deploy_component',
			project: 'my-app',
			payload,
			restart: true,
		}),
	});

	// ... assertions
});
```

---

## Scripts

### `scripts/setup-loopback.sh`

Bash script for setting up loopback addresses on the system.

**Usage:**

```bash
# Setup default 32 addresses (127.0.0.1-127.0.0.32)
./integrationTests/utils/scripts/setup-loopback.sh

# Setup custom count
HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT=64 ./integrationTests/utils/scripts/setup-loopback.sh
```

**Environment Variables:**

- `HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT` - Number of loopback addresses to configure (1-255, default: 32)

**Note:** This script requires `sudo` permissions and is currently designed for macOS. Review the script before executing.

---

### `scripts/run.mts`

The integration test runner script that configures and executes tests with appropriate concurrency settings.

This script is executed via `npm run test:integration` and handles:

- Setting safe default concurrency levels
- Validating loopback address availability
- Accepting CLI arguments and environment variable overrides
- Running the Node.js Test Runner with appropriate configuration

See the main [Integration Tests README](../README.md) for detailed usage and configuration options.
