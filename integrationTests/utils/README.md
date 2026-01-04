# Integration Test Utilities

This directory contains utility functions and modules for Harper integration tests. These utilities provide common functionality for setting up test environments, managing Harper instances, and performing test-related operations.

## Table of Contents

- [Harper Lifecycle Management](#harper-lifecycle-management)
- [Loopback Address Pool](#loopback-address-pool)
- [Compression Utilities](#compression-utilities)

---

## Harper Lifecycle Management

**Module:** [`harperLifecycle.mts`](./harperLifecycle.mts)

Provides functions for managing Harper instances during integration tests, including installation, startup, and teardown.

### `setupHarper(context, options?): Promise<ContextWithHarper>`

Sets up a complete Harper instance for testing.

**Parameters:**

- `context` - [`ContextWithHarper`](#contextwithharper) - The test context object
- `options` - [`SetupHarperOptions`](#setupharperoptions) (optional) - Configuration options for the setup process

**Returns:** `Promise<ContextWithHarper>` - The context with the `harper` property populated

**Description:**

This method should be used in the `before()` lifecycle hook for a test suite. It performs the following steps:

1. Creates a Harper instance in a temporary directory
2. Assigns a unique loopback address from the loopback address pool
3. Starts Harper with test configuration (which self-installs)
4. Waits for Harper to be fully started (default: 5 seconds, configurable via `options.startupDelayMs`)
5. Populates the `context.harper` object with connection details

**Important:** Always call `teardownHarper(ctx)` in the `after()` hook to properly clean up resources, or you will have phantom Harper processes after tests complete.

**Examples:**

```ts
import { suite, test, before, after } from 'node:test';
import { setupHarper, teardownHarper, type ContextWithHarper } from '../utils/harperLifecycle.mts';

// Default setup
suite('My test suite', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarper(ctx);
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

### `SetupHarperOptions`

Configuration options for `setupHarper()`.

**Interface Definition:**

```typescript
export interface SetupHarperOptions {
	/**
	 * Timeout in milliseconds to wait for Harper to start.
	 * @default 30000
	 */
	startupTimeoutMs?: number;
}
```

**Properties:**

- **`startupDelayMs`** - `number` (optional) - Time in milliseconds to wait after starting Harper before considering it ready. Defaults to 5000 (5 seconds), or the value of the `HARPER_INTEGRATION_TEST_STARTUP_DELAY_MS` environment variable if set.

**Environment Variables:**

- `HARPER_INTEGRATION_TEST_STARTUP_DELAY_MS` - Sets the default startup delay for all tests when `startupDelayMs` is not explicitly provided

---

### `teardownHarper(context): Promise<void>`

Tears down a Harper instance and cleans up all resources.

**Parameters:**

- `context` - [`ContextWithHarper`](#contextwithharper) - The test context with Harper instance details

**Returns:** `Promise<void>`

**Description:**

This method should be used in the `after()` lifecycle hook in conjunction with `setupHarper()` and `before()`. It performs the following cleanup steps:

1. Stops the Harper instance
2. Releases the loopback address back to the pool
3. Removes the Harper installation directory from the filesystem

**Example:**

```ts
suite('My test suite', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarper(ctx);
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
interface ContextWithHarper extends SuiteContext, TestContext {
	harper: {
		installDir: string;
		admin: {
			username: string;
			password: string;
		};
		httpURL: string;
		operationsAPIURL: string;
		loopbackAddress: string;
	};
}
```

**Properties:**

- **`harper`** - `object` - The Harper instance details
  - **`installDir`** - `string` - The absolute path to the Harper installation directory
  - **`admin`** - `object` - Admin credentials
    - **`username`** - `string` - The Harper Admin Username (default: `'admin'`)
    - **`password`** - `string` - The Harper Admin Password (default: `'Abc1234!'`)
  - **`httpURL`** - `string` - The HTTP URL for the Harper instance (e.g., `'http://127.0.0.2:9926'`)
  - **`operationsAPIURL`** - `string` - The Operations API URL (e.g., `'http://127.0.0.2:9925'`)
  - **`hostname`** - `string` - The assigned loopback IP address (e.g., `'127.0.0.2'`)

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

**Module:** [`loopbackAddressPool.mts`](./loopbackAddressPool.mts)

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

**Note:** This is automatically called by `setupHarper()`. You typically don't need to call this directly unless you're implementing custom test infrastructure.

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

**Module:** [`targz.mts`](./targz.mts)

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
