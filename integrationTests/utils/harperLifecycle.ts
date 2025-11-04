import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { type SuiteContext, type TestContext } from 'node:test';
import { once } from 'node:events';
import { getNextAvailableLoopbackAddress, releaseLoopbackAddress } from './loopbackAddressPool.ts';

// Constants
const HTTP_PORT = 9926;
const OPERATIONS_API_PORT = 9925;
const DEFAULT_ADMIN_USERNAME = 'HDB_ADMIN';
const DEFAULT_ADMIN_PASSWORD = 'abc123';
const DEFAULT_STARTUP_DELAY_MS = parseInt(process.env.HARPER_INTEGRATION_TEST_STARTUP_DELAY_MS, 10) || 5000;

/**
 * Options for setting up a Harper instance.
 */
export interface SetupHarperOptions {
	/**
	 * Time in milliseconds to wait for Harper to be fully started after the start command completes.
	 * @default 5000
	 */
	startupDelayMs?: number;
}

/**
 * Test context interface with Harper instance details.
 *
 * This interface is populated by `setupHarper()` and contains all necessary
 * information to interact with the test Harper instance.
 */
export interface ContextWithHarper extends SuiteContext, TestContext {
	harper: {
		/** Absolute path to the Harper installation directory */
		installDir: string;
		/** Admin credentials for the Harper instance */
		admin: {
			/** Admin username (default: 'HDB_ADMIN') */
			username: string;
			/** Admin password (default: 'abc123') */
			password: string;
		};
		/** HTTP URL for the Harper instance (e.g., 'http://127.0.0.2:9926') */
		httpURL: string;
		/** Operations API URL (e.g., 'http://127.0.0.2:9925') */
		operationsAPIURL: string;
		/** Assigned loopback IP address (e.g., '127.0.0.2') */
		loopbackAddress: string;
	};
}

/**
 * Gets the path to the Harper CLI script.
 *
 * @returns The absolute path to the Harper CLI entry script
 * @throws {AssertionError} If the script does not exist at the expected location
 */
function getHarperScript(): string {
	const harperScript =
		process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ||
		join(import.meta.dirname, '..', '..', 'dist', 'bin', 'harper.js');
	assert.ok(
		existsSync(harperScript),
		`Harper installation script not found at ${harperScript}. Don't forget to build the project (\`npm run build\`) before running integration tests.`
	);
	return harperScript;
}

/**
 * Runs a Harper CLI command and captures output.
 *
 * @param command - The Harper CLI command to run (e.g., 'install', 'start', 'stop')
 * @param args - Additional arguments to pass to the command
 * @throws {AssertionError} If the command exits with a non-zero status code
 */
async function runHarperCommand(command: string, args: string[]): Promise<void> {
	const harperScript = getHarperScript();
	const proc = spawn('node', [harperScript, command, ...args]);

	let stdout = '';
	let stderr = '';

	proc.stdout?.on('data', (data: Buffer) => {
		stdout += data.toString();
	});

	proc.stderr?.on('data', (data: Buffer) => {
		stderr += data.toString();
	});

	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const [statusCode] = await once(proc, 'exit');

	if (statusCode !== 0) {
		let errorMessage = `Harper ${command} failed with exit code ${statusCode}`;
		if (stdout) {
			errorMessage += `\n\nstdout:\n${stdout}`;
		}
		if (stderr) {
			errorMessage += `\n\nstderr:\n${stderr}`;
		}
		assert.fail(errorMessage);
	}
}

/**
 * Sets up a complete Harper instance for testing.
 *
 * This function performs installation, startup, and waits for Harper to be ready.
 * Always call `teardownHarper()` in the `after()` hook to clean up resources.
 *
 * @param ctx - The test context to populate with Harper instance details
 * @param options - Optional configuration for the setup process
 * @returns The context with the `harper` property populated
 *
 * @example
 * ```ts
 * suite('My tests', (ctx: ContextWithHarper) => {
 *   before(async () => {
 *     await setupHarper(ctx);
 *   });
 *
 *   after(async () => {
 *     await teardownHarper(ctx);
 *   });
 *
 *   test('can connect', async () => {
 *     const response = await fetch(ctx.harper.httpURL);
 *     // ...
 *   });
 * });
 * ```
 */
export async function setupHarper(ctx: ContextWithHarper, options?: SetupHarperOptions): Promise<ContextWithHarper> {
	await install(ctx);
	await startHarper(ctx);
	const startupDelay = options?.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
	await sleep(startupDelay);
	return ctx;
}

/**
 * Installs a Harper instance for testing.
 *
 * This is a lower-level function called by `setupHarper()`.
 * Most tests should use `setupHarper()` instead.
 *
 * @param ctx - The test context to populate with Harper installation details
 * @returns The context with the `harper` property populated
 */
async function install(ctx: ContextWithHarper): Promise<ContextWithHarper> {
	// Create a directory for this Harper installation
	// Use the system temp directory by default, or a custom parent directory if specified
	const installDirPrefix = join(
		process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(),
		`harper-integration-test-`
	);
	const installDir = await mkdtemp(installDirPrefix);

	const loopbackAddress = await getNextAvailableLoopbackAddress();

	await runHarperCommand('install', [
		`--ROOTPATH=${installDir}`,
		'--DEFAULTS_MODE=dev',
		`--HDB_ADMIN_USERNAME=${DEFAULT_ADMIN_USERNAME}`,
		`--HDB_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD}`,
		'--THREADS_COUNT=1',
		'--THREADS_DEBUG=false',
		`--NODE_HOSTNAME=${loopbackAddress}`,
		`--HTTP_PORT=${loopbackAddress}:${HTTP_PORT}`,
		`--OPERATIONSAPI_NETWORK_PORT=${loopbackAddress}:${OPERATIONS_API_PORT}`,
		'--LOGGING_LEVEL=debug',
	]);

	ctx.harper = {
		installDir,
		admin: {
			username: DEFAULT_ADMIN_USERNAME,
			password: DEFAULT_ADMIN_PASSWORD,
		},
		httpURL: `http://${loopbackAddress}:${HTTP_PORT}`,
		operationsAPIURL: `http://${loopbackAddress}:${OPERATIONS_API_PORT}`,
		loopbackAddress,
	};

	return ctx;
}

/**
 * Starts a Harper instance that has been installed.
 *
 * This is a lower-level function called by `setupHarper()`.
 * Most tests should use `setupHarper()` instead.
 *
 * @param ctx - The test context with Harper installation details
 */
async function startHarper(ctx: ContextWithHarper): Promise<void> {
	await runHarperCommand('start', [`--ROOTPATH=${ctx.harper.installDir}`]);
}

/**
 * Tears down a Harper instance and cleans up all resources.
 *
 * This function stops the Harper instance, releases the loopback address,
 * and removes the installation directory.
 *
 * @param ctx - The test context with Harper instance details
 *
 * @example
 * ```ts
 * suite('My tests', (ctx: ContextWithHarper) => {
 *   before(async () => {
 *     await setupHarper(ctx);
 *   });
 *
 *   after(async () => {
 *     await teardownHarper(ctx);
 *   });
 * });
 * ```
 */
export async function teardownHarper(ctx: ContextWithHarper): Promise<void> {
	await runHarperCommand('stop', [`--ROOTPATH=${ctx.harper.installDir}`]);

	await releaseLoopbackAddress(ctx.harper.loopbackAddress);

	await rm(ctx.harper.installDir, { recursive: true, force: true });
}
