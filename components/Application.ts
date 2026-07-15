import { type Logger } from '../utility/logging/logger.ts';
import { getConfigObj, getConfigValue, getConfigPath } from '../config/configUtils.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import logger from '../utility/logging/harper_logger.ts';
import { broadcastDeployStart, broadcastDeployEnd } from './deployLifecycle.ts';
import type { CredentialReference, ResolvedCredential, ResolvedRegistryCredential } from './secretOperations.ts';
import {
	GIT_CREDENTIAL_SOCKET_ENV,
	startGitCredentialSession,
	type GitCredentialSession,
	type ResolvedGitCredential,
} from './gitCredentialServer.ts';

import { basename, dirname, extname, join } from 'node:path';
import {
	access,
	constants,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

import { extract } from 'tar-fs';
import gunzip from 'gunzip-maybe';

interface ApplicationConfig {
	// define known config properties
	package: string;
	install?: {
		command?: string;
		timeout?: number;
		allowInstallScripts?: boolean;
	};
	// Deploy credentials in reference form only — each entry names an hdb_secret row, never a token.
	// Recorded by deploy_component so every (cold) install — reboot, new peer, rollback — re-resolves
	// the credential from the store rather than needing it re-supplied.
	credentials?: CredentialReference[];
	// an application config can have other arbitrary properties
	[key: string]: unknown;
}

export class InvalidPackageIdentifierError extends TypeError {
	constructor(applicationName: string, packageIdentifier: unknown) {
		super(
			`Invalid 'package' property for application ${applicationName}: expected string, got ${typeof packageIdentifier}`
		);
	}
}

export class InvalidInstallPropertyError extends TypeError {
	constructor(applicationName: string, installProperty: unknown) {
		super(
			`Invalid 'install' property for application ${applicationName}: expected object, got ${typeof installProperty}`
		);
	}
}

export class InvalidInstallCommandError extends TypeError {
	constructor(applicationName: string, command: unknown) {
		super(
			`Invalid 'install.command' property for application ${applicationName}: expected string, got ${typeof command}`
		);
	}
}

export class InvalidInstallTimeoutError extends TypeError {
	constructor(applicationName: string, timeout: unknown) {
		super(
			`Invalid 'install.timeout' property for application ${applicationName}: expected non-negative number, got ${typeof timeout}`
		);
	}
}

export class InvalidCredentialsPropertyError extends TypeError {
	constructor(applicationName: string, credentials: unknown) {
		super(
			`Invalid 'credentials' property for application ${applicationName}: expected array, got ${typeof credentials}`
		);
	}
}

export class InvalidCredentialEntryError extends TypeError {
	constructor(applicationName: string) {
		super(
			`Invalid 'credentials' entry for application ${applicationName}: expected a { registry, secret, scope? } ` +
				`or { host, secret, username? } reference`
		);
	}
}

export function assertApplicationConfig(
	applicationName: string,
	applicationConfig: Record<'package', unknown> & Record<string, unknown>
): asserts applicationConfig is ApplicationConfig {
	if (typeof applicationConfig.package !== 'string') {
		throw new InvalidPackageIdentifierError(applicationName, applicationConfig.package);
	}

	if ('install' in applicationConfig) {
		if (
			typeof applicationConfig.install !== 'object' ||
			applicationConfig.install === null ||
			Array.isArray(applicationConfig.install)
		) {
			throw new InvalidInstallPropertyError(applicationName, applicationConfig.install);
		}

		if ('command' in applicationConfig.install && typeof applicationConfig.install.command !== 'string') {
			throw new InvalidInstallCommandError(applicationName, applicationConfig.install.command);
		}

		if (
			'timeout' in applicationConfig.install &&
			(typeof applicationConfig.install.timeout !== 'number' || applicationConfig.install.timeout < 0)
		) {
			throw new InvalidInstallTimeoutError(applicationName, applicationConfig.install.timeout);
		}

		if (
			'allowInstallScripts' in applicationConfig.install &&
			typeof applicationConfig.install.allowInstallScripts !== 'boolean'
		) {
			throw new (class InvalidInstallAllowScriptsError extends TypeError {})(
				`Invalid 'install.allowInstallScripts' property for application ${applicationName}: expected boolean, got ${typeof applicationConfig.install.allowInstallScripts}`
			);
		}
	}
	if ('credentials' in applicationConfig && applicationConfig.credentials !== undefined) {
		const entries = applicationConfig.credentials;
		if (!Array.isArray(entries)) {
			throw new InvalidCredentialsPropertyError(applicationName, entries);
		}
		for (const entry of entries) {
			// Config carries references only — a literal `token` here would mean a plaintext credential
			// was persisted to disk, which the deploy path is designed to prevent. An entry is npm
			// registry auth (`registry`) XOR git host auth (`host`); anything else is not a credential we
			// know how to resolve, so reject it rather than install without it. An entry carrying both
			// discriminators, or a stray `token`, is rejected rather than coerced into a single kind.
			const record = entry as any;
			const hasRegistry = typeof record?.registry === 'string';
			const hasHost = typeof record?.host === 'string';
			if (
				typeof entry !== 'object' ||
				entry === null ||
				hasRegistry === hasHost || // neither, or both
				typeof record.secret !== 'string' ||
				record.token !== undefined
			) {
				throw new InvalidCredentialEntryError(applicationName);
			}
		}
	}
}

/**
 * Returns true when npm/git stderr indicates an SSH authentication failure —
 * git exits 128 with the standard "could not read" message, or the SSH layer
 * reports a missing uid (no SSH daemon user), explicit publickey denial, or
 * an unverified host key.
 */
export function isSSHAuthFailure(stderr: string): boolean {
	return (
		stderr.includes('Could not read from remote repository') ||
		stderr.includes('Permission denied (publickey)') ||
		stderr.includes('No user exists for uid') ||
		stderr.includes('Host key verification failed')
	);
}

// Git-reference package identifier forms recognized below for the credentialed-clone path: the
// npm git-url spec forms this repo's own derivePackageIdentifier can produce for a git host
// credential. An identifier that doesn't match falls back to `npm pack --ignore-scripts` (best
// effort, same as before this fix — not a regression for a form this can't safely reclone).
const GIT_URL_PREFIX = /^git\+(ssh|https?|file):\/\//i;
const GIT_PROTOCOL_PREFIX = /^git:\/\//i;

// Hosted-git shorthand prefixes: the same table derivePackageIdentifier implicitly relies on when it
// defaults a bare `owner/repo` to `github:owner/repo`, plus the other hosts npm's own shorthand spec
// recognizes. A bare `owner/repo` never reaches parseGitReference directly — the Application
// constructor always runs packageIdentifier through derivePackageIdentifier first, which turns it
// into `github:owner/repo` — so only the prefixed forms need handling here.
const HOSTED_GIT_HOSTS: Record<string, string> = {
	github: 'github.com',
	gitlab: 'gitlab.com',
	bitbucket: 'bitbucket.org',
	gist: 'gist.github.com',
};
const HOSTED_GIT_PREFIX = /^(github|gitlab|bitbucket|gist):(.+)$/i;

interface GitReference {
	cloneUrl: string;
	committish?: string;
}

/**
 * Parses a `git+ssh://…`/`git+https://…`/`git+http://…`/`git+file://…`/`git://…`, or hosted-git
 * shorthand (`github:owner/repo`, `gitlab:owner/repo`, `bitbucket:owner/repo`, `gist:id`) package
 * identifier into a plain clone URL and optional committish, without depending on npm's own git-spec
 * parser (npm-package-arg/hosted-git-info aren't dependencies of this repo). Returns null for any
 * other form.
 */
export function parseGitReference(packageIdentifier: string): GitReference | null {
	const hashIndex = packageIdentifier.indexOf('#');
	const committish = hashIndex === -1 ? undefined : packageIdentifier.slice(hashIndex + 1);
	const spec = hashIndex === -1 ? packageIdentifier : packageIdentifier.slice(0, hashIndex);
	if (GIT_URL_PREFIX.test(spec)) return { cloneUrl: spec.slice('git+'.length), committish };
	if (GIT_PROTOCOL_PREFIX.test(spec)) return { cloneUrl: spec, committish };
	const hostedMatch = HOSTED_GIT_PREFIX.exec(spec);
	if (hostedMatch) {
		const [, prefix, path] = hostedMatch;
		const host = HOSTED_GIT_HOSTS[prefix.toLowerCase()];
		// A gist clone URL is keyed by id alone; an optional `owner/` in the shorthand (npm accepts
		// `gist:[owner/]id`) has no place in the URL and is dropped.
		const urlPath =
			prefix.toLowerCase() === 'gist' && path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
		return { cloneUrl: `https://${host}/${urlPath}.git`, committish };
	}
	return null;
}

const NEUTRALIZED_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepack', 'prepare'];

/**
 * Clones a git reference ourselves — with the credential session's env, so the clone itself can
 * still authenticate — and packs the checkout with its lifecycle scripts stripped, instead of
 * letting `npm pack <git-url>` clone and pack it directly.
 *
 * `--ignore-scripts` is not a reliable suppression for a git source's own `prepare` script: pacote's
 * DirFetcher runs it unconditionally on npm versions before 11.0.0 (the
 * `if (this.opts.ignoreScripts) return` guard was only added upstream in npm 11) — which is exactly
 * what Node 22's bundled npm (10.9.x) ships. A credentialed clone can't depend on which npm version
 * happens to be on PATH, since a script running while the credential socket is reachable is exactly
 * what this feature exists to prevent — so the script is removed from the checkout before packing,
 * which works regardless of npm version.
 */
async function packGitReferenceWithoutScripts(
	application: Application,
	gitRef: GitReference,
	parentDirPath: string
): Promise<string> {
	const cloneDir = await mkdtemp(join(tmpdir(), 'harper-git-clone-'));
	try {
		const { code: cloneCode, stderr: cloneStderr } = await nonInteractiveSpawn(
			application.name,
			'git',
			['clone', '--quiet', gitRef.cloneUrl, cloneDir],
			parentDirPath,
			undefined,
			undefined,
			undefined,
			application.gitCredentialEnv
		);
		if (cloneCode !== 0) {
			if (isSSHAuthFailure(cloneStderr)) {
				throw new Error(
					`Failed to deploy private repository ${application.packageIdentifier}: SSH access failed. Verify the repository URL, configure an SSH key on this Harper instance, ensure the key has access to the target repository, and confirm the host is present in the ssh/known_hosts file.`,
					{ cause: new Error(cloneStderr) }
				);
			}
			throw new Error(`Failed to clone package ${application.packageIdentifier}: ${cloneStderr}`);
		}

		if (gitRef.committish) {
			const { code: checkoutCode, stderr: checkoutStderr } = await nonInteractiveSpawn(
				application.name,
				'git',
				['checkout', '--quiet', gitRef.committish],
				cloneDir
			);
			if (checkoutCode !== 0) {
				throw new Error(
					`Failed to check out '${gitRef.committish}' for ${application.packageIdentifier}: ${checkoutStderr}`
				);
			}
		}

		// Strip the checkout's own lifecycle scripts before packing — the mechanism above only
		// suppresses npm's git-clone behavior; a plain `npm pack <local-dir>` still runs `prepare`
		// unless it's gone from the manifest.
		const manifestPath = join(cloneDir, 'package.json');
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
		if (manifest.scripts) {
			for (const scriptName of NEUTRALIZED_LIFECYCLE_SCRIPTS) delete manifest.scripts[scriptName];
			await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
		}

		const { stdout, code, stderr } = await nonInteractiveSpawn(
			application.name,
			'npm',
			['pack', '--json', '--ignore-scripts', cloneDir],
			parentDirPath,
			undefined,
			undefined,
			application.npmUserconfigPath
		);
		if (code !== 0) {
			throw new Error(`Failed to pack package ${application.packageIdentifier}: ${stderr}`);
		}
		let packResult: Array<{ filename: string }>;
		try {
			packResult = JSON.parse(stdout.slice(stdout.indexOf('[')));
		} catch (err) {
			throw new Error(
				`Failed to parse npm pack output for ${application.packageIdentifier}: ${err.message}\nstdout: ${stdout}`
			);
		}
		if (!Array.isArray(packResult) || typeof packResult[0]?.filename !== 'string') {
			throw new Error(`Unexpected npm pack output for ${application.packageIdentifier}:\n${stdout}`);
		}
		return join(parentDirPath, packResult[0].filename);
	} finally {
		await rm(cloneDir, { recursive: true, force: true });
	}
}

// Hidden directory under the components root holding component versions renamed aside
// during a deploy swap (see extractApplication). The leading dot keeps
// loadComponentDirectories from loading its contents as components.
export const ASIDE_STAGING_DIR = '.deploy-aside';

// The credential helper git executes for a private git-reference deploy. It ships alongside this
// module (both in source and in dist), holds no secret, and is inert without a live session.
export const GIT_CREDENTIAL_HELPER_PATH = join(__dirname, 'gitCredentialHelper.js');

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
	let shouldDeleteTarball = false;

	if (application.payload) {
		const payload = application.payload;
		if (payload instanceof Readable) {
			// Stream payloads (e.g. multipart file part from the operations API) are piped
			// straight into extraction so multi-GB components don't have to materialize as a Buffer.
			tarball = payload;
		} else if (typeof payload === 'string') {
			// base64 string payload
			tarball = Readable.from(Buffer.from(payload, 'base64'));
		} else {
			tarball = Readable.from(payload as Buffer);
		}
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
			// `npm pack --json` writes a JSON array describing the packed tarball(s). This is also the
			// spawn that clones a git-reference package, so it is the only one given the git credential
			// environment.
			//
			// Packing a git reference is not just a download: npm clones the repo and, if its manifest
			// has a prepare/build/install script, runs `npm install` inside the clone and then that
			// script — so the repo's own code AND its dependencies' install scripts execute on this node,
			// inheriting this spawn's environment. With a credential session live, that is exactly the
			// reach the credential must not have (a transitive dependency's postinstall could ask the
			// socket for a token granted for the top-level repository), so scripts are off for a
			// credentialed clone unless the deploy explicitly opted into them.
			const scriptsDisallowed = application.gitCredentialEnv && !application.install?.allowInstallScripts;
			// `--ignore-scripts` alone isn't a reliable way to enforce that: pacote's DirFetcher runs a
			// git source's `prepare` unconditionally on npm versions before 11.0.0 (see
			// packGitReferenceWithoutScripts), which is exactly what Node 22's bundled npm ships. For a
			// recognized git-reference identifier, clone and pack it ourselves with scripts stripped
			// instead, sidestepping that npm code path entirely.
			const gitRef = scriptsDisallowed ? parseGitReference(application.packageIdentifier) : null;

			if (gitRef) {
				tarballPath = await packGitReferenceWithoutScripts(application, gitRef, parentDirPath);
			} else {
				const packArgs = ['pack', '--json', application.packageIdentifier];
				if (scriptsDisallowed) {
					packArgs.push('--ignore-scripts');
				} else if (application.gitCredentialEnv) {
					application.logger.warn(
						`Deploying ${application.name} from a git reference with install scripts enabled: the repository's ` +
							`prepare/build scripts and its dependencies' install scripts run on this node during the clone and ` +
							`can read the git credential. Unset install_allow_scripts to keep the credential out of their reach.`
					);
				}
				const { stdout, code, stderr } = await nonInteractiveSpawn(
					application.name,
					'npm',
					packArgs,
					parentDirPath,
					undefined,
					undefined,
					application.npmUserconfigPath,
					application.gitCredentialEnv
				);
				if (code !== 0) {
					if (isSSHAuthFailure(stderr)) {
						throw new Error(
							`Failed to deploy private repository ${application.packageIdentifier}: SSH access failed. Verify the repository URL, configure an SSH key on this Harper instance, ensure the key has access to the target repository, and confirm the host is present in the ssh/known_hosts file.`,
							{ cause: new Error(stderr) }
						);
					}
					throw new Error(`Failed to download package ${application.packageIdentifier}: ${stderr}`);
				}

				let packResult: Array<{ filename: string }>;
				try {
					packResult = JSON.parse(stdout.slice(stdout.indexOf('[')));
				} catch (err) {
					throw new Error(
						`Failed to parse npm pack output for ${application.packageIdentifier}: ${err.message}\nstdout: ${stdout}`
					);
				}
				if (!Array.isArray(packResult) || typeof packResult[0]?.filename !== 'string') {
					throw new Error(`Unexpected npm pack output for ${application.packageIdentifier}:\n${stdout}`);
				}

				tarballPath = join(parentDirPath, packResult[0].filename);
			}
			shouldDeleteTarball = true;
			tarball = createReadStream(tarballPath);
		}
	}

	// Replace any existing component directory atomically instead of clearing it in
	// place. A previous version's worker can still be running and actively writing
	// into this directory — e.g. a live Next.js app writing into `.next/cache` — and
	// an in-place recursive rm races that writer: rm empties `.next`, then its leaf
	// `rmdir('.next')` fails with ENOTEMPTY because the worker just re-created a cache
	// entry. (`force: true` only suppresses ENOENT; ENOTEMPTY is not retried unless
	// `maxRetries` is set, and a continuously-writing app would outlast retries
	// anyway.) Renaming the old directory aside is atomic and immune to the race: the
	// still-running worker keeps writing into the renamed inode harmlessly until it's
	// replaced on restart, and the aside copy is removed best-effort below.
	//
	// The aside lives under a hidden, component-scoped staging directory inside the
	// components root: same filesystem as the source so the rename stays atomic, the
	// leading dot keeps loadComponentDirectories from picking it up as a phantom
	// component, and the per-component path means a sibling component never collides
	// with (or sweeps) another's aside.
	const asideStagingDir = join(dirname(application.dirPath), ASIDE_STAGING_DIR, basename(application.dirPath));
	let didRenameAside = false;
	try {
		await access(application.dirPath, constants.F_OK);
		await mkdir(asideStagingDir, { recursive: true });
		await rename(application.dirPath, join(asideStagingDir, `${process.pid}-${Date.now()}-${randomUUID()}`));
		didRenameAside = true;
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
	if (shouldDeleteTarball && tarballPath) {
		await rm(tarballPath, { force: true });
	}

	// Remove this component's aside copies. The old worker may still hold files open
	// in the just-renamed copy (the live writer that motivated the rename), so this is
	// best-effort: removing the whole staging subdirectory also clears leftovers from
	// earlier deploys whose workers have since exited, and a copy that survives because
	// its worker is still live is swept by the next deploy. The failure is expected in
	// the live-worker case, so it's logged at trace rather than as a warning.
	if (didRenameAside) {
		rm(asideStagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((err) =>
			logger.trace?.(`Deferred cleanup of previous ${application.name} component directory: ${err.message}`)
		);
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
	let packageJSON: any;
	try {
		packageJSON = JSON.parse(await readFile(join(application.dirPath, 'package.json'), 'utf8'));
	} catch (err) {
		if (err.code !== 'ENOENT') throw err;
		// If no package.json, nothing to install
		application.logger.info(`Application ${application.name} has no package.json; skipping install`);
		return;
	}
	try {
		// Does node_modules exist?
		await access(join(application.dirPath, 'node_modules'), constants.F_OK);
		application.logger.info(`Application ${application.name} already has node_modules; skipping install`);
		return;
	} catch (err) {
		if (err.code !== 'ENOENT') throw err;
		// If node_modules doesn't exist, we need to install dependencies
	}

	// If custom install command is specified, run it
	if (application.install?.command) {
		const [command, ...args] = application.install.command.split(' ');
		const customOnLine = application.onInstallLine
			? (stream: 'stdout' | 'stderr', line: string) => application.onInstallLine!(command, stream, line)
			: undefined;
		const { stdout, stderr, code } = await nonInteractiveSpawn(
			application.name,
			command,
			args,
			application.dirPath,
			application.install?.timeout,
			customOnLine,
			application.npmUserconfigPath
		);
		// if it succeeds, return
		if (code === 0) {
			return;
		}
		if (stdout) {
			printStd(application.name, command, stdout, 'stdout', 'warn');
		}

		if (stderr) {
			printStd(application.name, command, stderr, 'stderr', 'warn');
		}
		// and throw a descriptive error
		throw new Error(
			`Failed to install dependencies for ${application.name} using custom install command: ${application.install.command}. Exit code: ${code}`
		);
	}

	// Next, try package.json devEngines field
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

		const pmOnLine = application.onInstallLine
			? (stream: 'stdout' | 'stderr', line: string) => application.onInstallLine!(packageManager.name, stream, line)
			: undefined;
		const { stdout, stderr, code } = await nonInteractiveSpawn(
			application.name,
			(application.packageManagerPrefix ? application.packageManagerPrefix + ' ' : '') + packageManager.name,
			application.install?.allowInstallScripts ? ['install'] : ['install', '--ignore-scripts'], // All of `npm`, `yarn`, and `pnpm` support the `install` command. If we need to configure options here we may have to use some other defaults though
			application.dirPath,
			application.install?.timeout,
			pmOnLine,
			application.npmUserconfigPath
		);

		// if it succeeds, return
		if (code === 0) {
			return;
		}

		// Otherwise handle failure case based on `onFail` value
		if (onFail === 'error') {
			// Log the std outputs using the error log level (in case the user doesn't have debug level set)
			if (stdout) {
				printStd(application.name, packageManager.name, stdout, 'stdout', 'error');
			}

			if (stderr) {
				printStd(application.name, packageManager.name, stderr, 'stderr', 'error');
			}

			// And throw an error instead of continuing
			throw new Error(
				`Failed to install dependencies for ${application.name} using ${packageManager.name}. Exit code: ${code}`
			);
		}

		// If onFail is 'warn', print outputs using the warn level, plus an additional message
		if (onFail === 'warn') {
			if (stdout) {
				printStd(application.name, packageManager.name, stdout, 'stdout', 'warn');
			}

			if (stderr) {
				printStd(application.name, packageManager.name, stderr, 'stderr', 'warn');
			}

			application.logger.warn(
				`Failed to install dependencies for ${application.name} using ${packageManager.name}. Exit code: ${code}`
			);
		}

		// But then fall through to installing with npm
	}

	// Finally, default to running `npm install`
	const npmInstallArgs = application.install?.allowInstallScripts
		? ['install', '--force']
		: ['install', '--force', '--ignore-scripts'];
	const npmOnLine = application.onInstallLine
		? (stream: 'stdout' | 'stderr', line: string) => application.onInstallLine!('npm', stream, line)
		: undefined;
	const { stdout, stderr, code } = await nonInteractiveSpawn(
		application.name,
		(application.packageManagerPrefix ? application.packageManagerPrefix + ' ' : '') + 'npm',
		npmInstallArgs,
		application.dirPath,
		application.install?.timeout,
		npmOnLine,
		application.npmUserconfigPath
	);

	// if it succeeds, return
	if (code === 0) {
		return;
	}

	// Otherwise, print the stdout and stderr outputs
	if (stdout) {
		printStd(application.name, 'npm', stdout, 'stdout', 'warn');
	}

	if (stderr) {
		printStd(application.name, 'npm', stderr, 'stderr', 'error');
	}

	// and throw a descriptive error
	throw new Error(`Failed to install dependencies for ${application.name} using npm default. Exit code: ${code}`);
}

/**
 * Callback invoked once per complete line of install stdout/stderr from
 * `nonInteractiveSpawn`. Threaded through `installApplication` to the underlying spawn
 * so a deploy can stream `npm install` output back to the caller as an SSE `install`
 * event in real time, rather than waiting for the process to exit. Line-buffered so a
 * chunk that splits mid-line never fires a partial line.
 */
export type OnInstallLine = (manager: string, stream: 'stdout' | 'stderr', line: string) => void;

interface ApplicationOptions {
	name: string;
	payload?: Buffer | string | Readable;
	packageIdentifier?: string;
	install?: { command?: string; timeout?: number; allowInstallScripts?: boolean };
	onInstallLine?: OnInstallLine;
	// Deploy credentials already resolved to literal tokens, of any kind; partitioned by the
	// constructor into the npm and git halves, which are injected by entirely different mechanisms.
	credentials?: ResolvedCredential[];
}

export class Application {
	name: string;
	payload?: Buffer | string | Readable;
	packageIdentifier?: string;
	install?: { command?: string; timeout?: number; allowInstallScripts?: boolean };
	onInstallLine?: OnInstallLine;
	dirPath: string;
	logger: Logger;
	packageManagerPrefix: string; // can be used to configure a package manager prefix, specifically "sfw".
	// Transient registry credentials provided by a deploy, already resolved to literal tokens. The
	// token is held only in memory and a per-deploy `.npmrc`; it is never persisted to config,
	// hdb_deployment, or replicated.
	registryCredentials?: ResolvedRegistryCredential[];
	// Transient git-host credentials, likewise resolved to literal tokens and held only in memory:
	// they are served to git over a per-deploy socket (gitCredentialServer.ts), never written anywhere.
	gitCredentials?: ResolvedGitCredential[];
	// Path to the per-deploy `.npmrc`, set by writeTransientNpmrc() during prepareApplication and
	// passed to the spawn calls; undefined when no registry credentials were provided.
	npmUserconfigPath?: string;
	#npmrcTempDir?: string;
	#gitCredentialSession?: GitCredentialSession;

	constructor({ name, payload, packageIdentifier, install, onInstallLine, credentials }: ApplicationOptions) {
		this.name = name;
		this.payload = payload;
		this.packageIdentifier = packageIdentifier && derivePackageIdentifier(packageIdentifier);
		this.install = install;
		this.onInstallLine = onInstallLine;
		// Split by kind: registry credentials go into the transient .npmrc, git credentials into the
		// credential socket. An entry belongs to exactly one of them (the op schema is an xor).
		// secretOperations owns the same predicate, but it is only ever imported from here lazily (it
		// pulls in the datastore), so this stays a local check rather than a boot-time import.
		if (credentials?.length) {
			const registryCredentials = credentials.filter(
				(entry): entry is ResolvedRegistryCredential => (entry as any).registry !== undefined
			);
			const gitCredentials = credentials.filter(
				(entry): entry is ResolvedGitCredential => (entry as any).registry === undefined
			);
			if (registryCredentials.length) this.registryCredentials = registryCredentials;
			if (gitCredentials.length) this.gitCredentials = gitCredentials;
		}
		const componentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
		if (!componentsRoot) throw new Error('componentsRoot is not configured');
		this.dirPath = join(componentsRoot, name);
		this.logger = logger.loggerWithTag(name);
		this.packageManagerPrefix = getConfigValue(CONFIG_PARAMS.APPLICATIONS_PACKAGEMANAGERPREFIX);
	}

	// Write the transient `.npmrc` into a fresh 0700 temp dir (file mode 0600) and record its path
	// so the deploy's npm spawns authenticate against the private registry. No-op without registry
	// credentials.
	//
	// Because `nonInteractiveSpawn` points npm at this single file (replacing any inherited
	// npm_config_userconfig), prepend the contents of an already-configured userconfig — e.g. a
	// fabric-injected file carrying cluster registries, a proxy, or a cafile — so those settings
	// survive. The transient auth is appended last so it wins on conflict (npm honors the last
	// value for a given key).
	async writeTransientNpmrc(): Promise<void> {
		if (!this.registryCredentials?.length) return;
		// Defensive: if called more than once, remove the prior temp dir first so it isn't leaked.
		if (this.#npmrcTempDir) await this.cleanupTransientNpmrc();
		this.#npmrcTempDir = await mkdtemp(join(tmpdir(), 'harper-npmrc-'));
		const npmrcPath = join(this.#npmrcTempDir, '.npmrc');
		let content = '';
		const inheritedUserconfig = process.env.npm_config_userconfig ?? process.env.NPM_CONFIG_USERCONFIG;
		if (inheritedUserconfig) {
			try {
				const inherited = await readFile(inheritedUserconfig, 'utf8');
				content = inherited.endsWith('\n') ? inherited : inherited + '\n';
			} catch (error: any) {
				// Missing inherited file is fine (npm would have created/ignored it); surface anything else.
				if (error?.code !== 'ENOENT') throw error;
			}
		}
		content += buildNpmrcContent(this.registryCredentials);
		await writeFile(npmrcPath, content, { mode: 0o600 });
		this.npmUserconfigPath = npmrcPath;
	}

	// Environment that lets git reach this deploy's credential socket. Applied ONLY to the spawn that
	// clones the git reference (`npm pack`) — see prepareApplication.
	get gitCredentialEnv(): Record<string, string> | undefined {
		return this.#gitCredentialSession?.env;
	}

	// Start serving this deploy's git-host credentials from memory. No-op without git credentials.
	async startGitCredentialSession(): Promise<void> {
		if (!this.gitCredentials?.length) return;
		if (this.#gitCredentialSession) await this.cleanupGitCredentialSession();
		this.#gitCredentialSession = await startGitCredentialSession(this.gitCredentials, GIT_CREDENTIAL_HELPER_PATH);
	}

	// Tear the socket down as soon as the clone is done, so nothing later in the deploy — including
	// the component's own install scripts — can still ask for the credential.
	async cleanupGitCredentialSession(): Promise<void> {
		const session = this.#gitCredentialSession;
		if (!session) return;
		this.#gitCredentialSession = undefined;
		try {
			await session.close();
		} catch (error) {
			// Called from prepareApplication's finally; a throw here would mask the deploy's own error.
			this.logger.warn(`Failed to close git credential session:`, error);
		} finally {
			// Drop the in-memory tokens too, so they can't surface in a later heap dump or error
			// serialization of this Application instance.
			this.gitCredentials = undefined;
		}
	}

	// Remove the transient `.npmrc` (and its temp dir) once the deploy's npm work is done.
	async cleanupTransientNpmrc(): Promise<void> {
		if (!this.#npmrcTempDir) return;
		try {
			await rm(this.#npmrcTempDir, { recursive: true, force: true });
		} catch (error) {
			// Called from prepareApplication's finally; a throw here (e.g. a Windows file lock) would
			// mask the original deploy error and skip broadcastDeployEnd. Log and always clear state.
			this.logger.warn(`Failed to remove transient .npmrc dir ${this.#npmrcTempDir}:`, error);
		} finally {
			this.#npmrcTempDir = undefined;
			this.npmUserconfigPath = undefined;
			// Drop the in-memory token array too, so it can't surface in a later heap dump or error
			// serialization of this Application instance.
			this.registryCredentials = undefined;
		}
	}
}

/**
 * Based on an old implementation for a method called `getPkgPrefix()` that was used
 * during the installation process in order to actually resolve what the user specifies for a
 * component matching some of npm's package resolution rules.
 */
export function derivePackageIdentifier(packageIdentifier: string) {
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
 * Bracketed with `deploy:start`/`deploy:end` lifecycle broadcasts so every
 * Harper thread's file watchers can suppress restart-on-change events while
 * the component directory is being rewritten — see harper#488 and
 * `components/deployLifecycle.ts`. The broadcast is best-effort: if it fails
 * (e.g. workers haven't started yet during initial install), the deploy still
 * proceeds.
 *
 * @param application The application to prepare.
 * @returns A promise that resolves when all preparation steps complete.
 */
export async function prepareApplication(application: Application) {
	await broadcastDeployStart(application.name);
	try {
		// Materialize the per-deploy `.npmrc` before extraction so both `npm pack` (extract) and
		// `npm install` authenticate against the private registry; always remove it afterward.
		await application.writeTransientNpmrc();
		try {
			// The git credential socket only has to be up for extraction — that is where npm resolves and
			// clones a git-reference package. Closing it before installApplication means the credential is
			// already gone by the time the component's dependency tree (and any install script it is
			// allowed to run) executes.
			await application.startGitCredentialSession();
			await extractApplication(application);
		} finally {
			await application.cleanupGitCredentialSession();
		}
		await installApplication(application);
	} finally {
		await application.cleanupTransientNpmrc();
		broadcastDeployEnd(application.name);
	}
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

	const componentsRootDirPath = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
	if (!componentsRootDirPath) throw new Error('componentsRoot is not configured');

	// Ensure component directory exists
	await mkdir(componentsRootDirPath, { recursive: true });

	const harperApplicationLockPath = join(getConfigValue(CONFIG_PARAMS.ROOTPATH), 'harper-application-lock.json');

	let harperApplicationLock: { applications: Record<string, ApplicationConfig> } = { applications: {} };
	try {
		harperApplicationLock = JSON.parse(await readFile(harperApplicationLockPath, 'utf8'));
	} catch (error) {
		// Ignore file not found error; will create new lock file after installations
		if (error.code !== 'ENOENT') {
			throw error;
		}
	}

	for (const [name, applicationConfig] of Object.entries(config)) {
		// Pre-validation check if the configuration is actually for an application
		// Don't want to throw an error here as the config may contain non-application entries
		if (typeof applicationConfig !== 'object' || applicationConfig === null || !('package' in applicationConfig)) {
			continue;
		}

		try {
			// Then do proper error-based validation with TypeScript `asserts` to provide type safety
			// This will throw if the config is invalid
			assertApplicationConfig(name, applicationConfig);

			// Resolve any credential references from the store so a cold install (fresh node, wiped
			// components dir, new peer that never installed) can authenticate without the token being
			// re-supplied. Best-effort: if custody isn't available yet or a referenced secret is
			// missing, log and install without it (a truly private package then fails in npm with its
			// own error) rather than blocking boot.
			let credentials: ResolvedCredential[] | undefined;
			if (applicationConfig.credentials?.length) {
				try {
					const { resolveCredentials } = await import('./secretOperations.ts');
					credentials = await resolveCredentials(applicationConfig.credentials, name);
				} catch (error) {
					logger.warn?.(
						`Could not resolve credentials for application ${name} at install time: ${(error as Error).message}`
					);
				}
			}

			const application = new Application({
				name,
				packageIdentifier: applicationConfig.package,
				install: applicationConfig.install,
				credentials,
			});

			// Lock check: only install if not already installed with matching configuration
			if (
				existsSync(application.dirPath) &&
				harperApplicationLock.applications[name] &&
				JSON.stringify(harperApplicationLock.applications[name]) === JSON.stringify(applicationConfig)
			) {
				logger.info?.(`Application ${name} is already installed with matching configuration; skipping installation`);
				continue;
			}

			applicationInstallationPromises.push(prepareApplication(application));

			harperApplicationLock.applications[name] = applicationConfig;
		} catch (error) {
			logger.error?.(`Skipping installation of application ${name} due to invalid configuration: ${error.message}`);
		}
	}

	const applicationInstallationStatuses = await Promise.allSettled(applicationInstallationPromises);
	logger.debug?.(applicationInstallationStatuses);
	logger.info?.('All root applications loaded');

	// Finally, write the lock file
	await writeFile(harperApplicationLockPath, JSON.stringify(harperApplicationLock, null, 2), 'utf8');
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

// Normalize a registry to a full URL with a scheme and trailing slash, e.g.
// `npm.pkg.github.com` or `//npm.pkg.github.com` → `https://npm.pkg.github.com/`.
function normalizeRegistryUrl(registry: string): string {
	let url = registry.trim();
	if (!/^https?:\/\//i.test(url)) {
		url = url.startsWith('//') ? `https:${url}` : `https://${url}`;
	}
	if (!url.endsWith('/')) url += '/';
	return url;
}

// Build the contents of a transient `.npmrc` from resolved registry credentials: an auth-token line keyed
// by npm's registry auth key (scheme stripped, leading `//`, trailing `/`) plus a registry-routing
// line. A scope routes only that `@scope` to the registry (`@scope:registry=…`); without a scope
// the entry sets npm's default `registry=…` so an unscoped package spec (e.g. `npm:my-private-app`)
// or its transitive deps actually resolve against this registry rather than the public default.
// A scope-less entry therefore requires its registry to serve/proxy whatever npm needs to install;
// with multiple scope-less entries npm's last-value-wins applies to the default `registry`.
export function buildNpmrcContent(registryCredentials: ResolvedRegistryCredential[]): string {
	const lines: string[] = [];
	for (const { registry, token, scope } of registryCredentials) {
		// Enforce the no-newline invariant at the injection point so it holds for every source. The
		// ops validator already rejects CR/LF in a literal `token`, but a token resolved from an
		// hdb_secret row bypasses that guard; without this a `\n` in a secret value would inject
		// arbitrary .npmrc lines (admin-only per the threat model, but the literal path already
		// defends this class).
		if (/[\r\n]/.test(token)) {
			throw new Error(`registry auth token for '${registry}' contains an illegal newline character`);
		}
		const registryUrl = normalizeRegistryUrl(registry);
		const authKey = registryUrl.replace(/^https?:/i, '');
		lines.push(`${authKey}:_authToken=${token}`);
		lines.push(scope ? `${scope}:registry=${registryUrl}` : `registry=${registryUrl}`);
	}
	return lines.join('\n') + '\n';
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
/**
 * Line-buffered split that emits complete `\n`-terminated lines as they
 * arrive, holding any partial trailing fragment until the next chunk or `flush()`.
 * Required because `child_process` stdout/stderr `'data'` events fire per OS-level
 * chunk, with no guarantee a chunk ends on a newline — without buffering, a long
 * `npm install` line could be reported to the caller as two halves.
 *
 * Uses StringDecoder so a multi-byte UTF-8 character (e.g. the ✔ emoji npm prints
 * for resolved packages) split across two chunks is reassembled into a single code
 * point rather than each half being decoded as replacement characters.
 */
function createLineSplitter(onLine: (line: string) => void): {
	push: (chunk: Buffer | string) => void;
	flush: () => void;
} {
	const decoder = new StringDecoder('utf8');
	let pending = '';
	return {
		push(chunk) {
			pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
			let nl: number;
			while ((nl = pending.indexOf('\n')) !== -1) {
				const line = pending.slice(0, nl).replace(/\r$/, '');
				pending = pending.slice(nl + 1);
				onLine(line);
			}
		},
		flush() {
			// Drain any bytes the decoder is still holding (e.g. a multi-byte char that
			// straddled the final chunk boundary).
			const remaining = decoder.end();
			if (remaining) pending += remaining;
			if (pending.length > 0) {
				onLine(pending);
				pending = '';
			}
		},
	};
}

export function nonInteractiveSpawn(
	applicationName: string,
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number = 60 * 60 * 1000,
	onLine?: (stream: 'stdout' | 'stderr', line: string) => void,
	npmUserconfigPath?: string,
	gitCredentialEnv?: Record<string, string>
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		logger
			.loggerWithTag(`${applicationName}:spawn:${command}`)
			.debug?.(`Executing \`${command} ${args.join(' ')}\` in ${cwd}`);

		const env = { ...process.env };

		const gitSSHCommand = getGitSSHCommand();
		if (gitSSHCommand) {
			env.GIT_SSH_COMMAND = gitSSHCommand;
		}

		// The git credential channel is granted per spawn, and only to the one that clones the git
		// reference. Every other spawn — notably `npm install`, where a dependency's install script can
		// run — has it removed, so a transitive dependency cannot ask for a credential that was supplied
		// for the top-level repository. Only the socket variable is stripped rather than any inherited
		// GIT_ASKPASS/GIT_CONFIG_*: those may be the operator's own git auth, and without a socket to
		// reach, our helper answers nothing and is inert.
		if (gitCredentialEnv) {
			Object.assign(env, gitCredentialEnv);
		} else {
			delete env[GIT_CREDENTIAL_SOCKET_ENV];
		}

		// A deploy carrying transient registry auth points npm at a per-deploy `.npmrc` so
		// `npm pack`/`install` can authenticate against a private registry without the token
		// ever touching disk durably, the package reference, config, or hdb_deployment.
		if (npmUserconfigPath) {
			// On case-insensitive platforms (Windows) an inherited NPM_CONFIG_USERCONFIG would
			// shadow the lowercase key we set, so drop any existing case variant first.
			for (const key of Object.keys(env)) {
				if (key.toLowerCase() === 'npm_config_userconfig') delete env[key];
			}
			env.npm_config_userconfig = npmUserconfigPath;
		}

		if (process.platform === 'win32' && command === 'npm') {
			command = 'npm.cmd';
		}

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

		// If a caller passed onLine, line-buffer stdout/stderr alongside the existing
		// string accumulation so we never report a half-line.
		const stdoutSplitter = onLine ? createLineSplitter((line) => onLine('stdout', line)) : null;
		const stderrSplitter = onLine ? createLineSplitter((line) => onLine('stderr', line)) : null;

		let stdout = '';
		childProcess.stdout.on('data', (chunk) => {
			// buffer stdout for later resolve
			stdout += chunk.toString();
			// log stdout lines immediately
			logger.loggerWithTag(`${applicationName}:spawn:${command}:stdout`).debug?.(chunk.toString());
			stdoutSplitter?.push(chunk);
		});

		// buffer stderr
		let stderr = '';
		childProcess.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
			stderrSplitter?.push(chunk);
		});

		childProcess.on('error', (error) => {
			clearTimeout(timeout);
			stdoutSplitter?.flush();
			stderrSplitter?.flush();
			// Print out stderr before rejecting
			if (stderr) {
				printStd(applicationName, command, stderr, 'stderr');
			}
			reject(error);
		});

		childProcess.on('close', (code) => {
			clearTimeout(timeout);
			// Flush any trailing partial lines so the caller sees process output that didn't
			// end on a newline (some package managers do this on their final progress line).
			stdoutSplitter?.flush();
			stderrSplitter?.flush();
			if (stderr) {
				printStd(applicationName, command, stderr, 'stderr');
			}
			logger.loggerWithTag(`${applicationName}:spawn:${command}`).debug?.(`Process exited with code ${code}`);
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

function printStd(
	applicationName: string,
	command: string,
	stdString: string,
	stdStreamLabel: 'stdout' | 'stderr',
	level: 'debug' | 'warn' | 'error' = 'debug'
) {
	const stdLogger = logger.loggerWithTag(`${applicationName}:spawn:${command}:${stdStreamLabel}`);
	for (const line of stdString.split('\n')) {
		stdLogger[level]?.(line);
	}
}
