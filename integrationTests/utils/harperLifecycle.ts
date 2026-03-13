import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, rmSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { type SuiteContext, type TestContext } from 'node:test';
import { getNextAvailableLoopbackAddress, releaseLoopbackAddress } from './loopbackAddressPool.ts';

// Constants
const HTTP_PORT = 9926;
export const OPERATIONS_API_PORT = 9925;
export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD = 'Abc1234!';
const DEFAULT_STARTUP_TIMEOUT_MS = parseInt(process.env.HARPER_INTEGRATION_TEST_STARTUP_TIMEOUT_MS, 10) || 30000;
const LOG_DIR = process.env.HARPER_INTEGRATION_TEST_LOG_DIR;

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
	/** Absolute path to the log directory for this suite (only set when HARPER_INTEGRATION_TEST_LOG_DIR is configured) */
	logDir?: string;
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
 * Sanitizes a string for use as a filesystem directory name.
 */
function sanitizeForFilesystem(name: string): string {
	return name
		.replace(/[^a-zA-Z0-9_-]/g, '_')
		.replace(/_+/g, '_')
		.substring(0, 100);
}

interface RunHarperCommandOptions {
	args: string[];
	env: any;
	completionMessage?: string;
	/** When set, stdout and stderr are written to files in this directory */
	logDir?: string;
}

/**
 * Runs a Harper CLI command and captures output.
 *
 * When `logDir` is provided, stdout and stderr are also written to files
 * (`stdout.log` and `stderr.log`) in that directory.
 *
 * @throws {AssertionError} If the command exits with a non-zero status code
 */
function runHarperCommand({ args, env, completionMessage, logDir }: RunHarperCommandOptions): Promise<ChildProcess> {
	const harperScript = getHarperScript();
	const proc = spawn('node', ['--trace-warnings', harperScript, ...args], {
		env: { ...process.env, ...env },
	});

	let stdoutStream: WriteStream | undefined;
	let stderrStream: WriteStream | undefined;
	if (logDir) {
		stdoutStream = createWriteStream(join(logDir, 'stdout.log'));
		stderrStream = createWriteStream(join(logDir, 'stderr.log'));
	}

	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		let timer = setTimeout(() => {
			let errorMessage = `Harper process timed out after ${DEFAULT_STARTUP_TIMEOUT_MS}ms`;
			if (stdout) {
				errorMessage += `\n\nstdout:\n${stdout}`;
			}
			if (stderr) {
				errorMessage += `\n\nstderr:\n${stderr}`;
			}
			reject(errorMessage);
			proc.kill();
		}, DEFAULT_STARTUP_TIMEOUT_MS);

		proc.stdout?.on('data', (data: Buffer) => {
			const dataString = data.toString();
			stdoutStream?.write(data);
			if (completionMessage && dataString.includes(completionMessage)) {
				clearTimeout(timer);
				resolve(proc);
			}
			stdout += dataString;
		});

		proc.stderr?.on('data', (data: Buffer) => {
			stderrStream?.write(data);
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
				stderrStream?.write(errorMessage);
				if (stderr) {
					errorMessage += `\n\nstderr:\n${stderr}`;
				}
				reject(errorMessage);
			}
			stdoutStream?.end();
			stderrStream?.end();
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
export async function startHarper(ctx: ContextWithHarper, options?: SetupHarperOptions): Promise<ContextWithHarper> {
	// Create a directory for this Harper installation
	// Use the system temp directory by default, or a custom parent directory if specified
	const installDirPrefix = join(
		process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(),
		`harper-integration-test-`
	);
	const installDir = ctx.harper?.installDir ?? (await mkdtemp(installDirPrefix));

	const loopbackAddress = ctx.harper?.hostname ?? (await getNextAvailableLoopbackAddress());

	// Set up per-suite log directory when HARPER_INTEGRATION_TEST_LOG_DIR is configured
	let logDir: string | undefined;
	if (LOG_DIR) {
		const suiteName = sanitizeForFilesystem(ctx.name || 'unknown');
		logDir = join(LOG_DIR, `${suiteName}-${sanitizeForFilesystem(loopbackAddress)}`);
		await mkdir(logDir, { recursive: true });
	}

	// Point Harper's log directory to the suite log dir so hdb.log is preserved for upload
	const config = { ...options?.config };
	if (logDir) {
		config.logging = { ...config.logging, root: logDir };

		// Clean up log directory on successful exit — only keep logs when tests fail
		process.on('exit', (code) => {
			if (code === 0) {
				try {
					rmSync(logDir, { recursive: true, force: true });
				} catch {}
			}
		});
	}

	const harperProcess = await runHarperCommand({
		args: [
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
			'--LOGGING_STDSTREAMS=false',
			'--HARPER_SET_CONFIG=' + JSON.stringify(config),
		],
		env: options?.env || {},
		completionMessage: 'successfully started',
		logDir,
	});

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
		logDir,
	};

	return ctx;
}

/**
 * Kill harper process (can be used for teardown, or killing it before a restart)
 * @param ctx
 */
export async function killHarper(ctx: ContextWithHarper): Promise<void> {
	await new Promise<void>((resolve) => {
		let timer: NodeJS.Timeout;
		ctx.harper.process.on('exit', () => {
			resolve();
			clearTimeout(timer);
		});
		ctx.harper.process.kill();
		timer = setTimeout(() => {
			try {
				ctx.harper.process.kill('SIGKILL');
			} catch {
				// possible that the process terminated but the exit event hasn't fired yet
			}
			resolve();
		}, 200);
	});
}

/**
 * Tears down a Harper instance and cleans up all resources.
 *
 * This function stops the Harper instance, releases the loopback address,
 * and removes the installation directory.
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
	await killHarper(ctx);

	await releaseLoopbackAddress(ctx.harper.hostname);

	// a few retries are typically necessary, might take a sec for a process to finish, especially since rocksdb may be flushing
	await rm(ctx.harper.installDir, { recursive: true, force: true, maxRetries: 4 });
}
