import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { type SuiteContext, type TestContext } from 'node:test';
import { getNextAvailableLoopbackAddress, releaseLoopbackAddress } from './loopbackAddressPool.ts';

// Constants
const HTTP_PORT = 9926;
export const OPERATIONS_API_PORT = 9925;
export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD = 'Abc1234!';
const REPLICATION_PORT = 9933;
const DEFAULT_STARTUP_TIMEOUT_MS = parseInt(process.env.HARPER_INTEGRATION_TEST_STARTUP_TIMEOUT_MS, 10) || 30000;

/**
 * Options for setting up a Harper instance.
 */
export interface SetupHarperOptions {
	/**
	 * Timeout in milliseconds to wait for Harper to start.
	 * @default 30000
	 */
	startupTimeoutMs?: number;
	/**
	 * Additional configuration options to pass to the Harper CLI.
	 */
	config: any;
	/**
	 * Environment variables to set when running Harper.
	 */
	env: any;
}

export interface HarperContext {
	/** Absolute path to the Harper installation directory */
	installDir: string;
	/** Admin credentials for the Harper instance */
	admin: {
		/** Admin username (default: 'admin') */
		username: string;
		/** Admin password (default: 'Abc1234!') */
		password: string;
	};
	/** HTTP URL for the Harper instance (e.g., 'http://127.0.0.2:9926') */
	httpURL: string;
	/** Operations API URL (e.g., 'http://127.0.0.2:9925') */
	operationsAPIURL: string;
	/** Assigned loopback IP address (e.g., '127.0.0.2') */
	hostname: string;
	/** Child process for the Harper instance */
	process: ChildProcess;
}

/**
 * Test context interface with Harper instance details.
 *
 * This interface is populated by `setupHarper()` and contains all necessary
 * information to interact with the test Harper instance.
 */
export interface ContextWithHarper extends SuiteContext, TestContext {
	harper: HarperContext;
}

/**
 * Gets the path to the Harper CLI script.
 *
 * @returns The absolute path to the Harper CLI entry script
 * @throws {AssertionError} If the script does not exist at the expected location
 */
function getHarperScript(): string {
	// import.meta.dirname doesn't seem to reliably work when running this across projects, if somehow compilation takes place, so fallback to module.path if necessary
	const harperScript =
		process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT ||
		join(import.meta.dirname ?? module.path, '..', '..', 'dist', 'bin', 'harper.js');
	assert.ok(
		existsSync(harperScript),
		`Harper installation script not found at ${harperScript}. Don't forget to build the project (\`npm run build\`) before running integration tests.`
	);
	return harperScript;
}

/**
 * Runs a Harper CLI command and captures output.
 *
 * @param args - Additional arguments to pass to the command
 * @throws {AssertionError} If the command exits with a non-zero status code
 */
function runHarperCommand(args: string[], env: any, completionMessage?: string): Promise<ChildProcess> {
	const harperScript = getHarperScript();
	const proc = spawn('node', [harperScript, ...args], {
		env: { ...process.env, ...env },
	});
	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		let timer = setTimeout(() => {
			reject(`Harper process timed out after ${DEFAULT_STARTUP_TIMEOUT_MS}ms`);
			proc.kill();
		}, DEFAULT_STARTUP_TIMEOUT_MS);

		proc.stdout?.on('data', (data: Buffer) => {
			const dataString = data.toString();
			if (completionMessage && dataString.includes(completionMessage)) {
				clearTimeout(timer);
				resolve(proc);
			}
			stdout += dataString;
		});

		proc.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString();
		});
		proc.on('error', (error) => {
			reject(error);
		});
		proc.on('exit', (statusCode) => {
			clearTimeout(timer);
			if (statusCode === 0) {
				resolve(proc);
			} else {
				let errorMessage = `Harper process failed with exit code ${statusCode}`;
				if (stderr) {
					errorMessage += `\n\nstderr:\n${stderr}`;
				}
				reject(errorMessage);
			}
		});
	});
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
	return startHarper(ctx, options);
}

/**
 * Starts a Harper instance that has been installed.
 *
 * This is a lower-level function called by `setupHarper()`.
 * Most tests should use `setupHarper()` instead.
 *
 * @param ctx - The test context with Harper installation details
 */
async function startHarper(ctx: ContextWithHarper, options?: SetupHarperOptions): Promise<ContextWithHarper> {
	// Create a directory for this Harper installation
	// Use the system temp directory by default, or a custom parent directory if specified
	const installDirPrefix = join(
		process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(),
		`harper-integration-test-`
	);
	const installDir = await mkdtemp(installDirPrefix);

	const loopbackAddress = ctx.hostname ?? (await getNextAvailableLoopbackAddress());
	const harperProcess = await runHarperCommand(
		[
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
			'--HARPER_SET_CONFIG=' + JSON.stringify(options?.config || {}),
		],
		options?.env || {},
		'successfully started'
	);

	ctx.harper = {
		installDir,
		admin: {
			username: DEFAULT_ADMIN_USERNAME,
			password: DEFAULT_ADMIN_PASSWORD,
		},
		httpURL: `http://${loopbackAddress}:${HTTP_PORT}`,
		operationsAPIURL: `http://${loopbackAddress}:${OPERATIONS_API_PORT}`,
		hostname: loopbackAddress,
		process: harperProcess,
	};

	return ctx;
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
	ctx.harper.process.kill();

	await releaseLoopbackAddress(ctx.harper.hostname);

	// a few retries are typically necessary, might take a sec for a process to finish, especially since rocksdb may be flushing
	await rm(ctx.harper.installDir, { recursive: true, force: true, maxRetries: 4 });
}
