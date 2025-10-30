import { getConfigObj, getConfigValue } from '../config/configUtils.js';
import { CONFIG_PARAMS } from '../utility/hdbTerms.js';
import logger from '../utility/logging/harper_logger.js';

import { dirname, extname, join } from 'node:path';
import { access, constants, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { extract } from 'tar-fs';
import gunzip from 'gunzip-maybe';

interface ApplicationConfig {
	package: string;
	install?: {
		command?: string;
		timeout?: number;
	};
}

export function assertApplicationConfig(
	applicationName: string,
	applicationConfig: object & Record<'package', unknown>
): asserts applicationConfig is ApplicationConfig {
	if (typeof applicationConfig.package !== 'string') {
		throw new TypeError(
			`Invalid 'package' property for application ${applicationName}: expected string, got ${typeof applicationConfig.package}`
		);
	}

	if ('install' in applicationConfig) {
		if (typeof applicationConfig.install !== 'object' || applicationConfig.install === null) {
			throw new TypeError(
				`Invalid 'install' property for application ${applicationName}: expected object, got ${typeof applicationConfig.install}`
			);
		}

		if ('command' in applicationConfig.install && typeof applicationConfig.install.command !== 'string') {
			throw new TypeError(
				`Invalid 'install.command' property for application ${applicationName}: expected string, got ${typeof applicationConfig.install.command}`
			);
		}

		if (
			'timeout' in applicationConfig.install &&
			(typeof applicationConfig.install.timeout !== 'number' || applicationConfig.install.timeout < 0)
		) {
			throw new TypeError(
				`Invalid 'install.timeout' property for application ${applicationName}: expected non-negativenumber, got ${typeof applicationConfig.install.timeout}`
			);
		}
	}
}

/**
 * Extract an application given payload (content of the application) or package (npm-compatible identifier to the application).
 *
 * Only one of `application.payload` or `application.package` should be specified; otherwise, an error is thrown.
 *
 * Writes the application to the configured components root directory using the `application.name` and overwrites any existing directory.
 *
 * This method should only be called from the main thread
 */
export async function extractApplication(application: Application) {
	// Can't specify neither
	if (!application.payload && !application.packageIdentifier) {
		throw new Error('Either payload or package must be provided');
	}

	// Can't specify both
	if (application.payload && application.packageIdentifier) {
		throw new Error('Both payload and package cannot be provided');
	}

	// Resolve the tarball from the input
	let tarballPath: string;
	let tarball: Readable;
	if (application.payload) {
		// Given a payload, create a Readable from the Buffer or string
		tarball = Readable.from(
			application.payload instanceof Buffer ? application.payload : Buffer.from(application.payload, 'base64')
		);
	} else {
		// Given a package, there are a a couple options
		const parentDirPath = dirname(application.dirPath);

		// If the package identifier is a file path we need to check if its a tarball or a directory
		if (application.packageIdentifier.startsWith('file:')) {
			const packagePath = application.packageIdentifier.slice(5);
			try {
				// Have to remove the 'file:' prefix in order to use fs methods
				const stats = await stat(packagePath);

				if (stats.isDirectory()) {
					// If its a directory, symlink
					await symlink(packagePath, application.dirPath, 'dir');
					// And return early since we're done; no extraction needed
					return;
				}

				if (!stats.isFile()) {
					throw new Error(`File path specified in package identifier is not a file or directory: ${packagePath}`);
				}

				// If its a file, we assume it can be unzipped and extracted.
				// We are using maybe-gunzip to handle both gzipped and non-gzipped tarballs
				// And then we are happy to let the `tar-fs` library handle the extraction.
				// Maybe worth adding some detection or at least some error handling if that step below fails.
				tarballPath = packagePath;
				tarball = createReadStream(tarballPath);
			} catch (err) {
				if (err.code === 'ENOENT') {
					throw new Error(`File path specified in package identifier does not exist: ${packagePath}`);
				} else {
					throw err;
				}
			}
		} else {
			// Given a package, resolve using `npm pack` (downloads the package as a tarball and writes the path to stdout)
			const {
				stdout: tarballFilePath,
				code,
				stderr,
			} = await nonInteractiveSpawn(application.name, 'npm', ['pack', application.packageIdentifier], parentDirPath);
			if (code !== 0) throw new Error(`Failed to download package ${application.packageIdentifier}: ${stderr}`);
			tarballPath = join(parentDirPath, tarballFilePath.trim());
			// Create a Readable from the tarball
			tarball = createReadStream(tarballPath);
		}
	}

	// Create the application directory
	try {
		await access(application.dirPath, constants.F_OK);
		// directory already exists; clear it
		await rm(application.dirPath, { recursive: true, force: true });
	} catch (err) {
		// Ignore does not exist error
		if (err.code !== 'ENOENT') {
			throw err;
		}
	}
	// Finally, create the application directory fresh
	await mkdir(application.dirPath, { recursive: true });

	// Now pipeline the tarball into maybe-gunzip then tar-fs to reliably decompress and extract the contents
	await pipeline(tarball, gunzip(), extract(application.dirPath));

	// If the extracted directory contains a single folder, move the contents up one level
	// The `npm pack` command does this (the top-level folder is called "package")
	// Other packing tools may have similar behavior, but the directory name is not guaranteed.
	const extracted = await readdir(application.dirPath, { withFileTypes: true });
	if (extracted.length === 1 && extracted[0].isDirectory()) {
		const topLevelDirPath = join(application.dirPath, extracted[0].name);

		const tempDirPath = await mkdtemp(application.dirPath);

		// Copy contents of top-level directory to temp directory (in order to avoid collisions of top-level directory name and one of the contents)
		await cp(topLevelDirPath, tempDirPath, { recursive: true });
		// Remove top-level directory
		await rm(topLevelDirPath, { recursive: true, force: true });
		// Copy contents of temp directory to application directory
		await cp(tempDirPath, application.dirPath, { recursive: true });
		// Finally, remove the temp dir
		await rm(tempDirPath, { recursive: true, force: true });
	}

	// Clean up the original tarball
	if (tarballPath) {
		await rm(tarballPath, { force: true });
	}
}

/**
 * Install an application to its relative `application.dirPath` using either a
 * configured `application.install` command, a derived package manager from the
 * application's `package.json#devEngines`, or falling back to the default
 * package manager, `npm`.
 *
 * Will return early if `node_modules` already exists within the `application.dirPath`
 *
 * This method should only be called from the main thread
 */
export async function installApplication(application: Application) {
	try {
		await access(join(application.dirPath, 'package.json'), constants.F_OK);
	} catch (err) {
		if (err.code !== 'ENOENT') throw err;
		// If no package.json, nothing to install
		application.logger.debug(`Application ${application.name} has no package.json; skipping install`);
		return;
	}
	try {
		// Does node_modules exist?
		await access(join(application.dirPath, 'node_modules'), constants.F_OK);
		application.logger.debug(`Application ${application.name} already has node_modules; skipping install`);
		return;
	} catch (err) {
		if (err.code !== 'ENOENT') throw err;
		// If node_modules doesn't exist, we need to install dependencies
	}

	// If custom install command is specified, run it
	if (application.install?.command) {
		const [command, ...args] = application.install.command.split(' ');
		const { stderr, code } = await nonInteractiveSpawn(
			application.name,
			command,
			args,
			application.dirPath,
			application.install?.timeout
		);
		// if it succeeds, return
		if (code === 0) {
			return;
		}
		// otherwise, print the stderr output
		printStderr(application.name, stderr, 'error');
		// and throw a descriptive error
		throw new Error(
			`Failed to install dependencies for ${application.name} using custom install command: ${application.install.command}. Exit code: ${code}`
		);
	}

	// Next, try package.json devEngines field
	const packageJSON = JSON.parse(await readFile(join(application.dirPath, 'package.json'), 'utf8'));

	const { packageManager } = packageJSON.devEngines || {};

	// Custom package manager specified
	if (packageManager) {
		// On any given system we want to leverage the `name` to match the package manager executable
		let onFail: string | undefined = packageManager.onFail;

		const validOnFailValues = ['ignore', 'warn', 'error'];

		if (onFail === 'download') {
			application.logger.warn(
				'Harper currently does not support `devEngines.packageManager.onFail = "download"`. Defaulting to "error"'
			);
			onFail = 'error';
		} else if (onFail && !validOnFailValues.includes(onFail)) {
			application.logger.error(
				`Invalid \`devEngines.packageManager.onFail\` value: "${onFail}". Expected one of ${validOnFailValues.map((v) => `"${v}"`).join(', ')}. Defaulting to "error"`
			);
			onFail = 'error';
		}

		onFail = onFail || 'error';

		// TODO: Implement a version check / resolution system
		// For example, say they specify a specific major version for their package manager
		// Maybe on our system, we have all of the supported majors (for a given Node.js major) of any supported package manager.
		// Then we can do something like <name>@<version> for the corresponding executable.
		// `devEngines: { packageManager: { name: 'pnpm', version: '>=7' } }`
		// Would result in `pnpm@7` being used as the executable.
		// Important note: an `npm` version should not be specifiable; the only valid npm version is the one installed alongside Node.js

		const { stderr, code } = await nonInteractiveSpawn(
			application.name,
			packageManager.name,
			['install'], // All of `npm`, `yarn`, and `pnpm` support the `install` command. If we need to configure options here we may have to use some other defaults though
			application.dirPath,
			application.install?.timeout
		);

		// if it succeeds, return
		if (code === 0) {
			return;
		}

		// Otherwise handle failure case based on `onFail` value
		if (onFail === 'error') {
			// Log the stderr using the error log level (in case the user doesn't have debug level set)
			printStderr(packageManager.name, stderr, 'error');
			// And throw an error instead of continuing
			throw new Error(
				`Failed to install dependencies for ${application.name} using ${packageManager.name}. Exit code: ${code}`
			);
		}

		// If onFail is 'warn', print out stderr using the warn level, plus an additional message
		if (onFail === 'warn') {
			// Log the stderr using the warn log level
			printStderr(packageManager.name, stderr, 'warn');

			application.logger.warn(
				`Failed to install dependencies for ${application.name} using ${packageManager.name}. Exit code: ${code}`
			);
		}

		// But then fall through to installing with npm
	}

	// Finally, default to running `npm install`
	const { stderr, code } = await nonInteractiveSpawn(
		application.name,
		'npm',
		['install', '--force'],
		application.dirPath
	);

	// if it succeeds, return
	if (code === 0) {
		return;
	}

	// Otherwise, print the stderr output
	printStderr(application.name, stderr, 'error');

	// and throw a descriptive error
	throw new Error(`Failed to install dependencies for ${application.name} using npm default. Exit code: ${code}`);
}

interface ApplicationOptions {
	name: string;
	payload?: Buffer | string;
	packageIdentifier?: string;
	install?: { command?: string; timeout?: number };
}

export class Application {
	name: string;
	payload?: Buffer | string;
	packageIdentifier?: string;
	install?: { command?: string; timeout?: number };
	dirPath: string;
	logger: any;

	constructor({ name, payload, packageIdentifier, install }: ApplicationOptions) {
		this.name = name;
		this.payload = payload;
		this.packageIdentifier = packageIdentifier && derivePackageIdentifier(packageIdentifier);
		this.install = install;
		this.dirPath = join(getConfigValue(CONFIG_PARAMS.COMPONENTSROOT), name);
		this.logger = logger.loggerWithTag(name);
	}
}

/**
 * Based on an old implementation for a method called `getPkgPrefix()` that was used
 * during the installation process in order to actually resolve what the user specifies for a
 * component matching some of npm's package resolution rules.
 */
function derivePackageIdentifier(packageIdentifier: string) {
	if (packageIdentifier.includes(':')) {
		return packageIdentifier;
	}
	if (packageIdentifier.startsWith('@') || (!packageIdentifier.startsWith('@') && !packageIdentifier.includes('/'))) {
		return `npm:${packageIdentifier}`;
	}
	if (extname(packageIdentifier) || existsSync(packageIdentifier)) {
		return `file:${packageIdentifier}`;
	}

	return `github:${packageIdentifier}`;
}

/**
 * Extract and install the specified application.
 *
 * This method should only be called from the main thread
 *
 * @param application The application to prepare.
 * @returns A promise that resolves when all preparation steps complete.
 */
export function prepareApplication(application: Application) {
	return extractApplication(application).then(() => installApplication(application));
}

/**
 * Install all applications specified in the root config.
 *
 * This method should only be called from the main thread otherwise certain
 * operations may conflict with each other (such as writing to the same directory).
 */
export async function installApplications() {
	const applicationInstallationPromises: Promise<void>[] = [];

	// first install any built-in components specified from env vars
	for (const { name, packageIdentifier } of getEnvBuiltInComponents()) {
		if (packageIdentifier.startsWith('@/')) {
			// this is a package relative module id, so later we will resolve it, but we don't need to install anything
			continue;
		}
		const application = new Application({
			name,
			packageIdentifier,
		});

		applicationInstallationPromises.push(prepareApplication(application));
	}

	const config = getConfigObj();

	const componentsRootDirPath = getConfigValue(CONFIG_PARAMS.COMPONENTSROOT);

	// Ensure component directory exists
	await mkdir(componentsRootDirPath, { recursive: true });

	for (const [name, applicationConfig] of Object.entries(config)) {
		// Pre-validation check if the configuration is actually for an application
		// Don't want to throw an error here as the config may contain non-application entries
		if (typeof applicationConfig !== 'object' || applicationConfig === null || !('package' in applicationConfig)) {
			continue;
		}

		// Then do proper error-based validation with TypeScript `asserts` to provide type safety
		// This will throw if the config is invalid
		assertApplicationConfig(name, applicationConfig);

		const application = new Application({
			name,
			packageIdentifier: applicationConfig.package,
			install: applicationConfig.install,
		});

		applicationInstallationPromises.push(prepareApplication(application));
	}

	const applicationInstallationStatuses = await Promise.allSettled(applicationInstallationPromises);
	logger.debug(applicationInstallationStatuses);
	logger.info('All root applications loaded');
}

function getGitSSHCommand() {
	const rootDir = getConfigValue(CONFIG_PARAMS.ROOTPATH);
	const sshDir = join(rootDir, 'ssh');
	if (existsSync(sshDir)) {
		for (const file of readdirSync(sshDir)) {
			if (file.includes('.key')) {
				return `ssh -F ${join(sshDir, 'config')} -o UserKnownHostsFile=${join(sshDir, 'known_hosts')}`;
			}
		}
	}
}

/**
 * Execute a command (using `spawn`) with stdin ignored.
 *
 * Stdout is logged chunk-by-chunk. Stderr is buffered and then logged line-by-line.
 *
 * Rejects with an error if the command fails or times out.
 *
 * @param command The command to run.
 * @param args The arguments to pass to the command.
 * @param cwd The working directory for the command.
 * @param timeoutMs The timeout for the command in milliseconds. Defaults to 5 minutes.
 * @returns A promise that resolves when the command completes.
 */
export function nonInteractiveSpawn(
	applicationName: string,
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number = 5 * 60 * 1000
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		logger
			.loggerWithTag(`${applicationName}:spawn:${command}`)
			.debug(`Executing \`${command} ${args.join(' ')}\` in ${cwd}`);

		const env = { ...process.env };

		const gitSSHCommand = getGitSSHCommand();
		if (gitSSHCommand) {
			env.GIT_SSH_COMMAND = gitSSHCommand;
		}

		// eslint-disable-next-line sonarjs/os-command
		const childProcess = spawn(command, args, {
			shell: true,
			cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		const timeout = setTimeout(() => {
			childProcess.kill();
			reject(new Error(`Command\`${command} ${args.join(' ')}\` timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		let stdout = '';
		childProcess.stdout.on('data', (chunk) => {
			// buffer stdout for later resolve
			stdout += chunk.toString();
			// log stdout lines immediately
			// TODO: Technically nothing guarantees that a chunk will be a complete line so need to implement
			// something here to buffer until a newline character, then log the complete line
			logger.loggerWithTag(`${applicationName}:spawn:${command}:stdout`).debug(chunk.toString());
		});

		// buffer stderr
		let stderr = '';
		childProcess.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});

		childProcess.on('error', (error) => {
			clearTimeout(timeout);
			// Print out stderr before rejecting
			if (stderr) {
				printStderr(applicationName, command, stderr);
			}
			reject(error);
		});

		childProcess.on('close', (code) => {
			clearTimeout(timeout);
			if (stderr) {
				printStderr(applicationName, command, stderr);
			}
			logger.loggerWithTag(`${applicationName}:spawn:${command}`).debug(`Process exited with code ${code}`);
			resolve({
				stdout,
				stderr,
				code,
			});
		});
	});
}

export function getEnvBuiltInComponents() {
	const builtInComponents: { name: string; packageIdentifier: string }[] = [];
	if (process.env.HARPER_BUILTIN_COMPONENTS) {
		for (const componentDefinition of process.env.HARPER_BUILTIN_COMPONENTS.split(',')) {
			const [name, packageIdentifier] = componentDefinition.trim().split('=');
			if (!componentDefinition) continue;
			builtInComponents.push({ name, packageIdentifier });
		}
	}
	return builtInComponents;
}

function printStderr(
	applicationName: string,
	command: string,
	stderr: string,
	level: 'debug' | 'warn' | 'error' = 'debug'
) {
	const stderrLogger = logger.loggerWithTag(`${applicationName}:spawn:${command}:stderr`);
	for (const line of stderr.split('\n')) {
		// Intentionally using the `debug` loglevel here since many CLIs, and predominantly package managers use stderr to report progress and metadata.
		stderrLogger[level](line);
	}
}
