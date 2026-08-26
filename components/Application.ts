import { type Logger } from '../utility/logging/logger.ts';
import { getConfigObj, getConfigValue, getConfigPath } from '../config/configUtils.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import logger, { errorForLog } from '../utility/logging/harper_logger.ts';
import { broadcastDeployStart, broadcastDeployEnd } from './deployLifecycle.ts';
import { ComponentPreparationLockTimeoutError, withComponentPreparationLock } from './componentPreparationLock.ts';
import { isThreadRunning, registerProcessGroup, unregisterProcessGroup } from '../server/threads/manageThreads.js';
import type { CredentialReference, ResolvedCredential, ResolvedRegistryCredential } from './secretOperations.ts';
import {
	GIT_CREDENTIAL_SOCKET_ENV,
	startGitCredentialSession,
	type GitCredentialSession,
	type ResolvedGitCredential,
} from './gitCredentialServer.ts';
import { getSecretDecryptor } from '../resources/secretDecryptor.ts';
import { ENV_ENCRYPTED_PREFIX } from '../utility/envFile.ts';

import { basename, dirname, extname, join } from 'node:path';
import {
	access,
	chmod,
	constants,
	lstat,
	mkdir,
	link,
	mkdtemp,
	open,
	readdir,
	readFile,
	rename,
	rmdir,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, lstatSync, renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';

import { extract } from 'tar-fs';
import gunzip from 'gunzip-maybe';
import semver from 'semver';

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
// credential, plus the raw forms a caller may pass directly (any identifier containing ':' is
// passed through as-is by derivePackageIdentifier). A form parseGitReference doesn't recognize but
// looksLikeGitReference does is treated as "recognized as git, but not safely handleable" (see
// extractApplication) rather than silently falling back to `npm pack --ignore-scripts`.
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

// A bare `https://`/`http://` URL to one of the hosts above is *also* a git-reference install, not a
// plain download: hosted-git-info (which npm's own git-arg resolution is built on) lists plain
// http/https in every host's `protocols` array, so `npm pack https://github.com/owner/repo` clones
// the repo exactly like the `git+https://` form does — it just doesn't carry the `git+` prefix that
// would otherwise mark it as one.
const BARE_GIT_HOST_URL_PREFIX = new RegExp(
	`^https?://(${Object.values(HOSTED_GIT_HOSTS)
		.map((host) => host.replace(/\./g, '\\.'))
		.join('|')})/`,
	'i'
);

interface GitReference {
	cloneUrl: string;
	committish?: string;
}

// True for a packageIdentifier that names a git source in some form parseGitReference recognizes OR
// doesn't (a malformed hosted shorthand, or a `#path:` committish naming npm's monorepo-subdirectory
// extension, which neither this nor the semver-committish resolution below implements). Lets
// extractApplication distinguish "not git at all" (safe to fall back to plain `npm pack
// --ignore-scripts`) from "git, but a form we can't safely reclone" (must fail loudly instead).
function looksLikeGitReference(packageIdentifier: string): boolean {
	return (
		GIT_URL_PREFIX.test(packageIdentifier) ||
		GIT_PROTOCOL_PREFIX.test(packageIdentifier) ||
		HOSTED_GIT_PREFIX.test(packageIdentifier) ||
		BARE_GIT_HOST_URL_PREFIX.test(packageIdentifier)
	);
}

/**
 * Parses a `git+ssh://…`/`git+https://…`/`git+http://…`/`git+file://…`/`git://…`, a bare
 * `https://`/`http://` URL to a known git host, or hosted-git shorthand (`github:owner/repo`,
 * `gitlab:owner/repo`, `bitbucket:owner/repo`, `gist:[owner/]id`) package identifier into a plain
 * clone URL and optional committish, without depending on npm's own git-spec parser
 * (npm-package-arg/hosted-git-info aren't dependencies of this repo).
 *
 * Returns null for a `#path:` committish (npm's git-url monorepo-subdirectory extension, which this
 * doesn't implement — a `#semver:` committish IS handled, downstream, by packGitReferenceWithoutScripts's
 * resolveCommittish) or for a hosted shorthand that isn't a plain `owner/repo` (or `gist:[owner/]id`)
 * — callers should treat that as "recognized as git, but not safely handleable" (see
 * looksLikeGitReference) rather than silently falling back.
 */
export function parseGitReference(packageIdentifier: string): GitReference | null {
	const hashIndex = packageIdentifier.indexOf('#');
	const committish = hashIndex === -1 ? undefined : packageIdentifier.slice(hashIndex + 1);
	if (committish?.startsWith('path:')) return null;
	const spec = hashIndex === -1 ? packageIdentifier : packageIdentifier.slice(0, hashIndex);
	if (GIT_URL_PREFIX.test(spec)) return { cloneUrl: spec.slice('git+'.length), committish };
	if (GIT_PROTOCOL_PREFIX.test(spec)) return { cloneUrl: spec, committish };
	// Both of these forms are ones npm resolves via hosted-git-info, which — unlike the explicit
	// `git+`/`git:` URL forms above — URL-decodes the whole committish while parsing it (e.g. a
	// branch name containing `/` arriving as `%2F`-escaped resolves correctly either way, but a
	// committish using other reserved characters needs this to match a real ref name).
	const decodedCommittish = committish === undefined ? undefined : decodeURIComponentOrRaw(committish);
	if (BARE_GIT_HOST_URL_PREFIX.test(spec)) return { cloneUrl: spec, committish: decodedCommittish };
	const hostedMatch = HOSTED_GIT_PREFIX.exec(spec);
	if (hostedMatch) {
		const [, prefix, path] = hostedMatch;
		const host = HOSTED_GIT_HOSTS[prefix.toLowerCase()];
		if (prefix.toLowerCase() === 'gist') {
			// A gist clone URL is keyed by id alone; an optional `owner/` in the shorthand (npm
			// accepts `gist:[owner/]id`) has no place in the URL and is dropped.
			const id = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
			if (!/^[^/#:]+$/.test(id)) return null;
			return { cloneUrl: `https://${host}/${id}.git`, committish: decodedCommittish };
		}
		if (!/^[^/#:]+\/[^/#:]+$/.test(path)) return null;
		return { cloneUrl: `https://${host}/${path}.git`, committish: decodedCommittish };
	}
	return null;
}

/** decodeURIComponent, falling back to the raw input on a malformed escape rather than throwing. */
function decodeURIComponentOrRaw(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

const NEUTRALIZED_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepack', 'prepare'];

// npm's hosted-git-info convention (documented in #1799's own worked example, `github:my-org/my-app#semver:v1.2.3`)
// for a committish that names a semver range instead of a literal ref. `git checkout` has no notion
// of this syntax, so it must be resolved to a concrete tag before checkout.
const SEMVER_COMMITTISH_PREFIX = /^semver:/i;

// Matches npm's own git-tag-to-version extraction (@npmcli/git's lines-to-revs.js): a trailing
// `1.2.3`-shaped suffix, optionally `v`-prefixed, with anything ahead of it ignored — so a tag like
// `release-v1.2.3` resolves the same way npm's own git-dependency installer treats it.
const TAG_VERSION_SUFFIX = /v?(\d+\.\d+\.\d+(?:[-+].+)?)$/;

// A conservative safe-charset check on the FULL tag name — not just the version-shaped suffix
// TAG_VERSION_SUFFIX matches. git's own ref-name rules (`check-ref-format`) permit shell
// metacharacters like `$`, backticks, `;`, `&`, `|`, `(`, `)` in a tag name; a prefix ahead of the
// matched suffix (e.g. the `release-` in `release-v1.2.3`) is otherwise unconstrained. The resolved
// name is later checked out via `nonInteractiveSpawn`, which runs through a shell with no argument
// escaping, so a tag such as `$(id)v1.2.3` in the cloned repo would otherwise execute on checkout.
// A tag failing this check is excluded from resolution entirely rather than sanitized or escaped —
// this only has to reject shell metacharacters, not accept every ref git itself would allow.
const SAFE_TAG_NAME = /^[\w][\w.-]*$/;

/**
 * Resolves a `semver:<range>` committish (e.g. `semver:v1.2.3`, `semver:^1.2.3`) against the tags of
 * the given clone to a concrete, unambiguous tag ref. Returns the committish unchanged if it isn't a
 * semver-range committish.
 */
async function resolveCommittish(application: Application, committish: string, cloneDir: string): Promise<string> {
	if (!SEMVER_COMMITTISH_PREFIX.test(committish)) return committish;
	// npm's own package-arg parser URL-decodes the value after `semver:` (a range containing `^`/`~`
	// can arrive percent-encoded, e.g. `#semver:%5E1.0.0`); do the same rather than evaluating it raw.
	// (A harmless no-op if parseGitReference already decoded the whole committish upstream.)
	const range = decodeURIComponentOrRaw(committish.slice('semver:'.length));

	// `git tag --list` rather than `for-each-ref --format=...`: nonInteractiveSpawn runs through a
	// shell, and a `%(...)` format string is unsafe to pass through one.
	const { code, stdout, stderr } = await nonInteractiveSpawn(application.name, 'git', ['tag', '--list'], cloneDir);
	if (code !== 0) {
		throw new Error(`Failed to list tags to resolve '${committish}' for ${application.packageIdentifier}: ${stderr}`);
	}
	const tags = stdout
		.split('\n')
		.map((tag) => tag.trim())
		.filter(Boolean);

	// A tag can be a bare version (`v1.2.3`) or carry a prefix ahead of one (`release-v1.2.3`); only
	// the trailing version-shaped suffix is evaluated against the range, but the ORIGINAL tag name is
	// what gets checked out.
	const versionToTag = new Map<string, string>();
	for (const tag of tags) {
		if (!SAFE_TAG_NAME.test(tag)) continue;
		const match = tag.match(TAG_VERSION_SUFFIX);
		const version = match && semver.valid(match[1], { loose: true });
		if (version) versionToTag.set(semver.clean(match[1], { loose: true }) as string, tag);
	}

	const resolvedVersion = semver.maxSatisfying([...versionToTag.keys()], range, { loose: true });
	if (!resolvedVersion) {
		throw new Error(
			`Failed to resolve '${committish}' for ${application.packageIdentifier}: no tag satisfies range '${range}'. ` +
				(tags.length ? `Tags found: ${tags.join(', ')}` : 'No tags were found in the repository.')
		);
	}
	// refs/tags/<name> rather than the bare name: an unqualified `git checkout <name>` resolves to a
	// same-named branch first if one exists, which would silently package the wrong commit.
	return `refs/tags/${versionToTag.get(resolvedVersion)}`;
}

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
			const committish = await resolveCommittish(application, gitRef.committish, cloneDir);
			const { code: checkoutCode, stderr: checkoutStderr } = await nonInteractiveSpawn(
				application.name,
				'git',
				['checkout', '--quiet', committish],
				cloneDir
			);
			if (checkoutCode !== 0) {
				throw new Error(`Failed to check out '${committish}' for ${application.packageIdentifier}: ${checkoutStderr}`);
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

		return await runNpmPack(application, ['pack', '--json', '--ignore-scripts', cloneDir], parentDirPath);
	} finally {
		await rm(cloneDir, { recursive: true, force: true });
	}
}

/**
 * Runs `npm pack` with the given args and returns the resulting tarball's path under `cwd`. Shared
 * between the git-reference reclone path above and the plain identifier path in extractApplication.
 */
async function runNpmPack(
	application: Application,
	packArgs: string[],
	cwd: string,
	gitCredentialEnv?: Record<string, string>
): Promise<string> {
	const { stdout, code, stderr } = await nonInteractiveSpawn(
		application.name,
		'npm',
		packArgs,
		cwd,
		undefined,
		undefined,
		application.npmUserconfigPath,
		gitCredentialEnv
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

	return join(cwd, packResult[0].filename);
}

// Hidden directory under the components root holding component versions renamed aside
// during a deploy swap (see extractApplication). The leading dot keeps
// loadComponentDirectories from loading its contents as components.
export const ASIDE_STAGING_DIR = '.deploy-aside';
// Hidden directory under the components root holding per-deployment candidate builds. A candidate is
// extracted, installed AND validated here, and only then renamed into the live path, so the previous
// version keeps serving through the slow, failure-prone work. Dot-prefixed so the three scans over the
// components root (componentLoader, componentEnvPrepass, resolvePreload) skip it.
export const DEPLOY_STAGING_DIR = '.deploy-staging';
const IN_PROGRESS_ASIDE_PREFIX = '.in-progress-';
const RETIRED_ASIDE_PREFIX = '.retired-';
const PRIOR_ABSENT_RECORD_SUFFIX = '-prior-absent';
const DEFAULT_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
const COMPONENT_PREPARATION_WAIT_MARGIN_MS = 30000;
const COMPONENT_RECOVERY_WAIT_TIMEOUT_MS = 30000;
const COMPONENT_RECOVERY_TRY_TIMEOUT_MS = 250;
const COMPONENT_RECOVERY_LOCK_PURPOSE = 'component-recovery';
const MAX_GIT_EXTRACTION_COMMANDS = 4;
const MAX_INSTALL_COMMANDS = 2;

type ExtractionTransaction = {
	commit(): Promise<void>;
	rollback(): Promise<void>;
};

type ExtractionContext = Pick<Application, 'name' | 'dirPath' | 'logger'>;

// The credential helper git executes for a private git-reference deploy. It ships alongside this
// module (both in source and in dist), holds no secret, and is inert without a live session.
export const GIT_CREDENTIAL_HELPER_PATH = join(__dirname, 'gitCredentialHelper.js');

const PACKAGE_LOCK_FILES = [
	'package-lock.json',
	'npm-shrinkwrap.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'bun.lock',
	'bun.lockb',
];

type InstalledPackageMetadata = {
	files: Map<string, Buffer>;
	readable: boolean;
	hasLockfile: boolean;
	hasInstallableDependencies: boolean;
};

export async function readInstalledPackageMetadata(directory: string): Promise<InstalledPackageMetadata> {
	const files = new Map<string, Buffer>();
	let readable = true;
	let packageJSON: any;
	await Promise.all([
		(async () => {
			try {
				const contents = await readFile(join(directory, 'package.json'));
				try {
					packageJSON = JSON.parse(contents.toString());
					files.set('package.json', Buffer.from(JSON.stringify(canonicalizeJSON(packageJSON))));
				} catch {
					files.set('package.json', contents);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') readable = false;
			}
		})(),
		...PACKAGE_LOCK_FILES.map(async (filename) => {
			try {
				files.set(filename, await readFile(join(directory, filename)));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') readable = false;
			}
		}),
	]);
	return {
		files,
		readable,
		hasLockfile: PACKAGE_LOCK_FILES.some((filename) => files.has(filename)),
		hasInstallableDependencies: ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(
			(field) => {
				const dependencies = packageJSON?.[field];
				return (
					typeof dependencies === 'object' &&
					dependencies !== null &&
					!Array.isArray(dependencies) &&
					Object.keys(dependencies).length > 0
				);
			}
		),
	};
}

export function installedPackageMetadataEqual(
	previous: InstalledPackageMetadata,
	current: InstalledPackageMetadata
): boolean {
	if (!previous.readable || !current.readable || previous.files.size !== current.files.size) return false;
	for (const [filename, contents] of previous.files) {
		if (!current.files.get(filename)?.equals(contents)) return false;
	}
	return true;
}

export function installedRuntimeChanged(
	previous: InstalledPackageMetadata,
	current: InstalledPackageMetadata,
	installationIsOpaque: boolean
): boolean {
	return (
		installationIsOpaque ||
		(current.hasInstallableDependencies && !current.hasLockfile) ||
		!installedPackageMetadataEqual(previous, current)
	);
}

function canonicalizeJSON(value: any): any {
	if (Array.isArray(value)) return value.map(canonicalizeJSON);
	if (!value || typeof value !== 'object') return value;
	const canonical: Record<string, any> = Object.create(null);
	for (const key of Object.keys(value).sort()) canonical[key] = canonicalizeJSON(value[key]);
	return canonical;
}

/**
 * Extract an application given payload (content of the application) or package (npm-compatible identifier to the application).
 *
 * Only one of `application.payload` or `application.package` should be specified; otherwise, an error is thrown.
 *
 * Writes the application to the configured components root directory using the `application.name` and overwrites any existing directory.
 *
 * This method may be called from any Harper thread. Same-component calls are serialized across
 * threads by the preparation lock below.
 */
/**
 * Either a tarball to extract, or — for `file:<directory>` — an instruction to link that directory. The
 * link case must be a RESULT rather than an action: the resolver used to symlink straight onto the live
 * path and return nothing, which both bypassed the candidate (so a `file:` deploy was published without
 * validation) and left `buildCandidateApplication` destructuring `undefined`.
 */
type ResolvedTarball =
	| { kind: 'tarball'; tarball: Readable; tarballPath?: string; shouldDeleteTarball: boolean }
	| { kind: 'link'; sourceDirPath: string };

/**
 * Turn a component's `payload` or `package` into a readable tarball stream. Pure input resolution: it
 * touches neither the live tree nor any staging directory, which is what lets both the in-place extraction
 * path and a candidate build share it.
 */
async function resolveApplicationTarball(application: Application): Promise<ResolvedTarball> {
	let tarballPath: string | undefined;
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
					// Reported, not performed — the caller decides where the link goes.
					return { kind: 'link', sourceDirPath: packagePath };
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
			// script — so the repository's (and its dependencies') install scripts can execute on this
			// node during the pack step alone, independent of the later `npm install`.
			// `install_allow_scripts` is the operator-facing switch for whether component code is
			// allowed to run scripts on this node at all — with a credential session live, an
			// unreviewed script also reaching the socket (a transitive dependency's postinstall asking
			// for a token granted to the top-level repository) is exactly the reach the credential must
			// not have, so this gates the pack step regardless of whether a credential happens to be in
			// play.
			const allowScripts = !!application.install?.allowInstallScripts;
			if (allowScripts) application.installationIsOpaque = true;
			// `--ignore-scripts` alone isn't a reliable way to enforce that: pacote's DirFetcher runs a
			// git source's `prepare` unconditionally on npm versions before 11.0.0 (see
			// packGitReferenceWithoutScripts), which is exactly what Node 22's bundled npm ships. For a
			// recognized git-reference identifier, clone and pack it ourselves with scripts stripped
			// instead, sidestepping that npm code path entirely.
			const gitRef = allowScripts ? null : parseGitReference(application.packageIdentifier);

			if (!allowScripts && !gitRef && looksLikeGitReference(application.packageIdentifier)) {
				// Recognized as git, but a form the reclone-and-strip-scripts path above can't safely
				// handle (a `#path:` committish, or a hosted shorthand other than a plain `owner/repo`) —
				// fail loudly rather than silently falling through to the unreliable `npm pack
				// --ignore-scripts` below.
				throw new Error(
					`Cannot deploy git-reference package '${application.packageIdentifier}' with install scripts disallowed: this identifier's form (e.g. a '#path:' committish, or a hosted shorthand other than a plain 'owner/repo') isn't one this repo's script-suppression handling supports. Set install.allowInstallScripts to true, or use a plain git URL with a branch/tag/commit committish instead.`
				);
			}

			if (gitRef) {
				tarballPath = await packGitReferenceWithoutScripts(application, gitRef, parentDirPath);
			} else {
				const packArgs = ['pack', '--json', application.packageIdentifier];
				if (!allowScripts) {
					packArgs.push('--ignore-scripts');
				} else if (application.gitCredentialEnv) {
					application.logger.warn(
						`Deploying ${application.name} from a git reference with install scripts enabled: the repository's ` +
							`prepare/build scripts and its dependencies' install scripts run on this node during the clone and ` +
							`can read the git credential. Unset install_allow_scripts to keep the credential out of their reach.`
					);
				}
				tarballPath = await runNpmPack(application, packArgs, parentDirPath, application.gitCredentialEnv);
			}
			shouldDeleteTarball = true;
			tarball = createReadStream(tarballPath);
		}
	}

	return { kind: 'tarball', tarball, tarballPath, shouldDeleteTarball };
}

/**
 * Extract a tarball into `targetDirPath`, flattening the single wrapping directory npm pack produces.
 * `scratchDirPath` must be on the same filesystem as the target: the flatten is done by renaming the
 * wrapper out and back rather than copying, so it stays atomic per entry. Windows moves the children
 * individually because renaming a directory over its own parent's path fails there.
 */
async function extractTarballInto(
	tarball: Readable,
	targetDirPath: string,
	scratchDirPath: string
): Promise<string | undefined> {
	await mkdir(targetDirPath, { recursive: true });
	await pipeline(tarball, gunzip(), extract(targetDirPath));

	const extracted = await readdir(targetDirPath, { withFileTypes: true });
	if (extracted.length === 1 && extracted[0].isDirectory()) {
		const topLevelDirPath = join(targetDirPath, extracted[0].name);
		if (process.platform === 'win32') {
			for (const childName of await readdir(topLevelDirPath)) {
				await rename(join(topLevelDirPath, childName), join(targetDirPath, childName));
			}
			await rmdir(topLevelDirPath);
		} else {
			const tempDirPath = join(scratchDirPath, `.normalize-${process.pid}-${Date.now()}-${randomUUID()}`);
			await rename(topLevelDirPath, tempDirPath);
			await rmdir(targetDirPath);
			await rename(tempDirPath, targetDirPath);
			return tempDirPath;
		}
	}
	return undefined;
}

export async function extractApplication(
	application: Application,
	deferCommit = false
): Promise<ExtractionTransaction | undefined> {
	// Can't specify neither
	if (!application.payload && !application.packageIdentifier) {
		throw new Error('Either payload or package must be provided');
	}

	// Can't specify both
	if (application.payload && application.packageIdentifier) {
		throw new Error('Both payload and package cannot be provided');
	}
	// Resolve the tarball from the input
	const resolved = await resolveApplicationTarball(application);
	if (resolved.kind === 'link') {
		// Unchanged behavior for this path: a `file:` directory is linked in place, no extraction.
		await symlink(resolved.sourceDirPath, application.dirPath, 'dir');
		return;
	}
	const { tarball, tarballPath, shouldDeleteTarball } = resolved;
	// Replace any existing component directory atomically instead of clearing it in
	// place. A previous version's worker can still be running and actively writing
	// into this directory — e.g. a live Next.js app writing into `.next/cache` — and
	// an in-place recursive rm races that writer: rm empties `.next`, then its leaf
	// `rmdir('.next')` fails with ENOTEMPTY because the worker just re-created a cache
	// entry. (`force: true` only suppresses ENOENT; ENOTEMPTY is not retried unless
	// `maxRetries` is set, and a continuously-writing app would outlast retries
	// anyway.) Renaming the old directory aside is atomic and immune to the race: the
	// still-running worker keeps writing into the renamed inode harmlessly until it's
	// replaced on restart. The aside remains the rollback/recovery record until commit
	// marks it retired and cleanup removes it.
	//
	// The aside lives under a hidden, component-scoped staging directory inside the
	// components root: same filesystem as the source so the rename stays atomic, the
	// leading dot keeps loadComponentDirectories from picking it up as a phantom
	// component, and the per-component path means a sibling component never collides
	// with (or sweeps) another's aside.
	const asideStagingDir = extractionStagingDirectory(application.dirPath);
	const transactionPaths = new Set<string>();
	let asidePath: string | undefined;
	let recoveryRecordPath: string;
	try {
		await ensureExtractionStagingDirectory(asideStagingDir);
		await recoverOrCleanupStaleExtractionPaths(application, asideStagingDir);
		let componentExists = true;
		try {
			await lstat(application.dirPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			componentExists = false;
		}
		if (componentExists) {
			await ensureExtractionStagingDirectory(asideStagingDir);
			asidePath = join(asideStagingDir, `${IN_PROGRESS_ASIDE_PREFIX}${Date.now()}-${process.pid}-${randomUUID()}`);
			await rename(application.dirPath, asidePath);
			transactionPaths.add(asidePath);
			recoveryRecordPath = asidePath;
		} else {
			await ensureExtractionStagingDirectory(asideStagingDir);
			recoveryRecordPath = join(
				asideStagingDir,
				`${IN_PROGRESS_ASIDE_PREFIX}${Date.now()}-${process.pid}-${randomUUID()}${PRIOR_ABSENT_RECORD_SUFFIX}`
			);
			await writeFile(recoveryRecordPath, '', { flag: 'wx', mode: 0o600 });
			transactionPaths.add(recoveryRecordPath);
		}
		if (asidePath) application.isNewComponent = false;

		try {
			// The scratch dir for the pack-wrapper flatten has to be on the component root's filesystem, and
			// is a transaction path so a crash mid-flatten is cleaned up with the rest.
			await ensureExtractionStagingDirectory(asideStagingDir);
			const normalizeTempPath = await extractTarballInto(tarball, application.dirPath, asideStagingDir);
			if (normalizeTempPath) transactionPaths.add(normalizeTempPath);
		} catch (error) {
			try {
				await rollbackExtractedDirectory(application, asideStagingDir, asidePath, transactionPaths, false);
			} catch (rollbackError) {
				throw new AggregateError(
					[error, rollbackError],
					`Failed to extract ${application.name}: ${errorMessage(error)}; ` +
						`also failed to restore its previous component directory: ${errorMessage(rollbackError)}`
				);
			}
			throw error;
		}
	} finally {
		if (!tarball.destroyed) tarball.destroy();
		if (shouldDeleteTarball && tarballPath) {
			await rm(tarballPath, { force: true }).catch((error) =>
				application.logger.warn(`Failed to remove temporary package ${tarballPath}:`, error)
			);
		}
	}

	let settled = false;
	const transaction: ExtractionTransaction = {
		async commit() {
			if (settled) return;
			const retiredMarkerPath = await retireExtractionAside(recoveryRecordPath);
			transactionPaths.add(retiredMarkerPath);
			settled = true;
			await cleanupExtractionPaths(application, asideStagingDir, transactionPaths);
		},
		async rollback() {
			if (settled) return;
			await rollbackExtractedDirectory(application, asideStagingDir, asidePath, transactionPaths, true);
			settled = true;
		},
	};
	if (deferCommit) return transaction;
	await transaction.commit();
}

// Written into a candidate's deployment directory once its build and its validation have BOTH succeeded.
// Roll-forward authority: recovery may activate an interrupted candidate only if this is present.
const CANDIDATE_COMPLETE_MARKER = '.complete';
// Records activation intent beside the candidate, so recovery finishes or undoes the whole transaction —
// tree and configuration together — instead of inferring intent from filesystem shape alone.
const ACTIVATION_JOURNAL = 'activation.json';
const ACTIVATION_JOURNAL_VERSION = 1;

/**
 * Best-effort fsync of a directory, so a rename or create has a chance of reaching stable storage.
 * Best-effort by necessity: Node cannot open a directory for fsync on Windows, and some filesystems
 * reject it. The activation protocol is therefore built to never DEPEND on directory-entry durability —
 * roll-forward requires the journal and the candidate and its complete marker to all be observable, so a
 * lost directory update degrades to a roll back rather than to a wrong decision.
 */
async function syncDirectory(dirPath: string): Promise<void> {
	let handle;
	try {
		handle = await open(dirPath, 'r');
	} catch (error) {
		// Windows cannot open a directory for fsync at all, so this is the expected path there rather than
		// a fault. Traced, not warned, because the protocol tolerates it by design.
		logger.trace?.(`Directory sync of ${dirPath} unavailable: ${errorMessage(error)}`);
		return;
	}
	try {
		await handle.sync();
	} catch (error) {
		logger.trace?.(`Directory sync of ${dirPath} failed: ${errorMessage(error)}`);
	} finally {
		await handle.close();
	}
}

/**
 * A rename changes an entry in BOTH parents — the removal in the source's and the addition in the
 * destination's — so durability has to be attempted on both. Syncing only the destination can leave the
 * source entry present after power loss, which reads as "candidate still there" and rolls forward twice.
 */
async function syncRenameParents(fromPath: string, toPath: string): Promise<void> {
	const parents = new Set([dirname(fromPath), dirname(toPath)]);
	for (const parent of parents) await syncDirectory(parent);
}

/**
 * Write a control file so its final name NEVER exists with partial contents. Opening the final path with
 * `wx` publishes the directory entry before anything is written, so a crash in between leaves a zero-byte
 * file — which for the journal means "unreadable", failing a component closed over a deploy that had not
 * actually started. Contents land in a temp name, are fsynced, and only then renamed into place.
 */
async function writeControlFileDurably(filePath: string, contents: string): Promise<void> {
	const tempPath = `${filePath}.partial-${process.pid}-${randomUUID()}`;
	const handle = await open(tempPath, 'wx', 0o600);
	try {
		await handle.writeFile(contents, 'utf8');
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		// `wx` on the temp name plus this rename keeps the EEXIST semantics callers rely on to detect a
		// retry of the same activation.
		await link(tempPath, filePath);
	} finally {
		await rm(tempPath, { force: true });
	}
	await syncDirectory(dirname(filePath));
}

type ActivationJournal = {
	v: number;
	component: string;
	candidateId: string;
	/**
	 * Whether this activation owns a config effect at all. Boot re-installs deliberately have none: they
	 * start FROM authoritative config, so they must neither republish nor compensate it. Without this flag
	 * their absent entries journal identically to an explicit "remove this component's entry", and recovery
	 * of a crashed boot reinstall would DELETE the config it was installing from.
	 */
	publishesConfig: boolean;
	// This component's root-config entry ONLY, never a whole-file snapshot: two components activating at
	// once would each restore a snapshot predating the other's write and delete its entry. `null` means
	// the component had (or should have) no entry — meaningful only when `publishesConfig` is true.
	// Credential REFERENCES only, never resolved tokens.
	configBefore: Record<string, any> | null;
	configAfter: Record<string, any> | null;
};

function candidateCompleteMarkerPath(componentDirPath: string, deploymentId: string): string {
	return join(candidateDeploymentDirPath(componentDirPath, deploymentId), CANDIDATE_COMPLETE_MARKER);
}

function activationJournalPath(componentDirPath: string, deploymentId: string): string {
	return join(candidateDeploymentDirPath(componentDirPath, deploymentId), ACTIVATION_JOURNAL);
}

/**
 * Read an activation journal. Absent is `undefined` — no activation was attempted. Anything else THROWS:
 * a truncated or unknown-version journal is an interrupted activation whose intent cannot be read, and
 * both guesses are destructive (publish a rejected release, or discard a good one), so the component is
 * failed closed instead.
 */
async function readActivationJournal(journalPath: string): Promise<ActivationJournal | undefined> {
	let raw: string;
	try {
		raw = await readFile(journalPath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Activation journal ${journalPath} could not be parsed: ${errorMessage(error)}`);
	}
	if (parsed?.v !== ACTIVATION_JOURNAL_VERSION) {
		throw new Error(
			`Activation journal ${journalPath} has version ${JSON.stringify(parsed?.v)}, expected ${ACTIVATION_JOURNAL_VERSION}`
		);
	}
	if (typeof parsed.component !== 'string' || !parsed.component || typeof parsed.candidateId !== 'string') {
		throw new Error(`Activation journal ${journalPath} does not identify its component and candidate`);
	}
	if (typeof parsed.publishesConfig !== 'boolean') {
		throw new Error(`Activation journal ${journalPath} does not say whether it owns a config effect`);
	}
	if (parsed.configBefore !== null && typeof parsed.configBefore !== 'object') {
		throw new Error(`Activation journal ${journalPath} has a malformed configBefore`);
	}
	if (parsed.configAfter !== null && typeof parsed.configAfter !== 'object') {
		throw new Error(`Activation journal ${journalPath} has a malformed configAfter`);
	}
	return parsed as ActivationJournal;
}

/** The deployment directory holding one candidate build: `<root>/.deploy-staging/<deploymentId>`. */
function candidateDeploymentDirPath(componentDirPath: string, deploymentId: string): string {
	return join(dirname(componentDirPath), DEPLOY_STAGING_DIR, deploymentId);
}

/** Where a candidate build lives: `<root>/.deploy-staging/<deploymentId>/<component>`. */
export function candidateApplicationPath(componentDirPath: string, deploymentId: string): string {
	return join(candidateDeploymentDirPath(componentDirPath, deploymentId), basename(componentDirPath));
}

function extractionStagingDirectory(componentDirPath: string): string {
	return join(dirname(componentDirPath), ASIDE_STAGING_DIR, basename(componentDirPath));
}

function retiredMarkerForAside(asidePath: string): string {
	return join(
		dirname(asidePath),
		`${RETIRED_ASIDE_PREFIX}${basename(asidePath).slice(IN_PROGRESS_ASIDE_PREFIX.length)}`
	);
}

async function retireExtractionAside(asidePath: string): Promise<string> {
	const retiredMarkerPath = retiredMarkerForAside(asidePath);
	try {
		await writeFile(retiredMarkerPath, '', { flag: 'wx', mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	return retiredMarkerPath;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function makeRollbackPlaceholderMovable(
	applicationDirPath: string,
	placeholderIdentity: { dev: bigint; ino: bigint } | undefined
): Promise<void> {
	if (!placeholderIdentity) return;
	try {
		const current = await lstat(applicationDirPath, { bigint: true });
		if (current.dev === placeholderIdentity.dev && current.ino === placeholderIdentity.ino) {
			await chmod(applicationDirPath, 0o700);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}

async function identifyRollbackPlaceholder(
	applicationDirPath: string
): Promise<{ dev: bigint; ino: bigint } | undefined> {
	const userId = process.getuid?.();
	if (process.platform === 'win32' || userId === undefined || userId === 0) return undefined;
	try {
		const current = await lstat(applicationDirPath, { bigint: true });
		const permissions = Number(current.mode) & 0o777;
		if (
			(current.isDirectory() || current.isFile()) &&
			current.uid === BigInt(userId) &&
			(permissions === 0 || (current.isDirectory() && (permissions === 0o100 || permissions === 0o300)))
		) {
			return { dev: current.dev, ino: current.ino };
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	return undefined;
}

/**
 * Create a hidden staging directory and confirm it is the one we created: a real directory rather than a
 * symlink or junction substituted underneath us, restricted to the owner. Re-checked at every use rather
 * than once per deploy, because the gap between checking and writing is the exploitable part.
 */
async function ensureSecureStagingDirectory(stagingDir: string): Promise<void> {
	await mkdir(stagingDir, { recursive: true, mode: 0o700 });
	const stagingStat = await lstat(stagingDir);
	if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
		throw new Error(`Component deploy staging path is not a directory: ${stagingDir}`);
	}
	if (process.platform !== 'win32' && (stagingStat.mode & 0o777) !== 0o700) {
		await chmod(stagingDir, 0o700).catch((error) =>
			logger.warn(`Could not restrict component deploy staging permissions for ${stagingDir}:`, errorForLog(error))
		);
	}
}

async function ensureExtractionStagingDirectory(asideStagingDir: string): Promise<void> {
	for (const stagingDir of [dirname(asideStagingDir), asideStagingDir]) {
		await ensureSecureStagingDirectory(stagingDir);
	}
}

/**
 * Build a deploy candidate at `.deploy-staging/<deploymentId>/<component>`, leaving the live tree
 * completely untouched — this is what lets the previous version keep serving through the clone, the
 * extraction and the dependency install.
 *
 * Failure needs no compensation, which is the whole point: nothing about the live component was modified,
 * so the abandoned candidate is simply removed and the error propagates.
 */
/** The single component directory inside a candidate deployment directory, when there is exactly one. */
async function candidateComponentName(deploymentDirPath: string): Promise<string | undefined> {
	const entries = await readdir(deploymentDirPath, { withFileTypes: true }).catch(() => []);
	const components = entries.filter((entry) => entry.isDirectory());
	return components.length === 1 ? components[0].name : undefined;
}

/** In-progress rollback records in a component's aside directory, newest first. */
async function inProgressAsideRecords(asideStagingDir: string): Promise<string[]> {
	const entries = await readdir(asideStagingDir, { withFileTypes: true }).catch(() => []);
	return entries
		.filter((entry) => entry.name.startsWith(IN_PROGRESS_ASIDE_PREFIX))
		.map((entry) => join(asideStagingDir, entry.name))
		.sort()
		.reverse();
}

/**
 * Settle activations a crash interrupted, before anything loads. Runs on the main thread at startup.
 *
 * Returns failures keyed by COMPONENT so the caller can fail exactly those closed and still load every
 * healthy sibling — a single unreadable journal must not take down the whole node, and must not let a
 * component load over state nobody reconciled.
 *
 * `publishConfig` applies one component's root-config entry (`null` removes it). It is supplied by the
 * caller so this module stays out of the business of deciding config policy.
 */
export async function recoverInterruptedActivations(
	componentsRootDirPath: string,
	publishConfig: (component: string, entry: Record<string, any> | null) => Promise<void>
): Promise<Map<string, Error>> {
	const failures = new Map<string, Error>();
	const stagingRoot = join(componentsRootDirPath, DEPLOY_STAGING_DIR);
	let deployments;
	try {
		deployments = await readdir(stagingRoot, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failures;
		throw error;
	}

	for (const deployment of deployments) {
		if (!deployment.isDirectory()) continue;
		const deploymentDirPath = join(stagingRoot, deployment.name);
		const journalPath = join(deploymentDirPath, ACTIVATION_JOURNAL);
		const fail = (component: string, error: unknown) => {
			const failure = error instanceof Error ? error : new Error(String(error));
			if (!failures.has(component)) failures.set(component, failure);
			logger.error(`Could not settle the interrupted activation of ${component}:`, errorForLog(failure));
		};

		let journal: ActivationJournal | undefined;
		try {
			journal = await readActivationJournal(journalPath);
		} catch (error) {
			// The journal itself is unreadable, so its component has to be inferred from the tree it was
			// going to activate. A deployment directory holding no component tree leaves only its id.
			fail((await candidateComponentName(deploymentDirPath)) ?? deployment.name, error);
			continue;
		}
		if (!journal) {
			// No activation was ever attempted: build residue, or a candidate abandoned mid-build. The
			// legacy in-place recovery owns any aside it left, so there is nothing to settle here.
			await rm(deploymentDirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			continue;
		}
		try {
			const settling = journal;
			await withComponentPreparationLock(
				join(componentsRootDirPath, settling.component),
				() => settleInterruptedActivation(componentsRootDirPath, deploymentDirPath, settling, publishConfig),
				{ purpose: 'activation-recovery' }
			);
		} catch (error) {
			// The journal named its component, so attribution is exact however the settle failed.
			fail(journal.component, error);
		}
	}
	return failures;
}

/**
 * One interrupted activation, under the component preparation lock. Ambiguity exists only while the live
 * path is absent, and there the `complete` marker is the roll-forward authority: without it the candidate
 * was never validated, so the committed tree in the aside wins. Every branch is idempotent, so a crash
 * during recovery is settled by the next run.
 */
async function settleInterruptedActivation(
	componentsRootDirPath: string,
	deploymentDirPath: string,
	journal: ActivationJournal,
	publishConfig: (component: string, entry: Record<string, any> | null) => Promise<void>
): Promise<void> {
	const liveDirPath = join(componentsRootDirPath, journal.component);
	const candidateDirPath = join(deploymentDirPath, journal.component);
	const asideStagingDir = extractionStagingDirectory(liveDirPath);
	const journalPath = join(deploymentDirPath, ACTIVATION_JOURNAL);

	const exists = async (path: string) =>
		lstat(path).then(
			() => true,
			(error) => {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
				throw error;
			}
		);
	const liveExists = await exists(liveDirPath);
	const candidateExists = await exists(candidateDirPath);
	const candidateComplete = await exists(join(deploymentDirPath, CANDIDATE_COMPLETE_MARKER));
	const asideRecords = await inProgressAsideRecords(asideStagingDir);

	const rollForward = async () => {
		if (!liveExists) await rename(candidateDirPath, liveDirPath);
		await syncRenameParents(candidateDirPath, liveDirPath);
		if (journal.publishesConfig) await publishConfig(journal.component, journal.configAfter ?? null);
		for (const record of asideRecords) {
			// Retiring only marks the displaced tree disposable; sweeping it is what keeps the components
			// root from growing by a component version for every activation a crash interrupted.
			const retiredMarkerPath = await retireExtractionAside(record);
			await cleanupExtractionPaths(
				{ name: journal.component, dirPath: liveDirPath, logger },
				asideStagingDir,
				new Set([record, retiredMarkerPath])
			);
		}
	};
	const rollBack = async (restoreFrom?: string) => {
		if (restoreFrom) {
			await rename(restoreFrom, liveDirPath);
			await syncRenameParents(restoreFrom, liveDirPath);
		}
		if (journal.publishesConfig) await publishConfig(journal.component, journal.configBefore ?? null);
		for (const record of asideRecords) await rm(record, { recursive: true, force: true });
	};

	if (!liveExists) {
		if (candidateExists && candidateComplete) {
			await rollForward();
		} else {
			// The tree that was moved aside is the last committed one. A `-prior-absent` record means there
			// was nothing live to begin with, so rolling back means leaving the component absent.
			const restorable = asideRecords.find((record) => !record.endsWith(PRIOR_ABSENT_RECORD_SUFFIX));
			if (!restorable && !asideRecords.length) {
				throw new Error(
					`Cannot settle the interrupted activation of ${journal.component}: it has neither a live tree, ` +
						`a complete candidate, nor a rollback record, so no version of it can be recovered`
				);
			}
			await rollBack(restorable);
		}
	} else if (candidateExists) {
		// Never activated, or already rolled back. Either way the live tree stands and the candidate goes.
		await rollBack();
	} else {
		// The candidate is already live; only the tail of the transaction was lost.
		await rollForward();
	}

	await rm(journalPath, { force: true });
	await rm(deploymentDirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

type CandidateActivation = {
	/** This component's root-config entry as it stands now, so a roll back can put it back. */
	configBefore?: Record<string, any> | null;
	/** What the entry should say once the candidate is live. `null` removes it. */
	configAfter?: Record<string, any> | null;
	/** Publishes `configAfter`. Called after the tree is live and before the aside is retired. */
	publishConfig?: (entry: Record<string, any> | null) => Promise<void>;
};

/** Mark a candidate build+validation complete. Idempotent, so a retried activation is not a failure. */
/**
 * fsync every regular file in the candidate tree, then its directories bottom-up. Without this the small
 * control files can survive a power loss while the candidate's contents do not, so recovery rolls forward
 * onto a truncated tree that `.complete` swears is good. Bounded by the candidate's own size and only on
 * the deploy path.
 */
async function syncTreeContents(rootPath: string): Promise<void> {
	const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const entryPath = join(rootPath, entry.name);
		if (entry.isDirectory()) {
			await syncTreeContents(entryPath);
		} else if (entry.isFile()) {
			let handle;
			try {
				handle = await open(entryPath, 'r');
			} catch {
				continue;
			}
			try {
				await handle.sync();
			} catch (error) {
				logger.trace?.(`Sync of ${entryPath} failed: ${errorMessage(error)}`);
			} finally {
				await handle.close();
			}
		}
	}
	await syncDirectory(rootPath);
}

async function markCandidateComplete(componentDirPath: string, deploymentId: string): Promise<void> {
	// Contents first: `.complete` is roll-forward AUTHORITY, so it must not be durable before the tree it
	// vouches for.
	await syncTreeContents(candidateApplicationPath(componentDirPath, deploymentId));
	try {
		await writeControlFileDurably(candidateCompleteMarkerPath(componentDirPath, deploymentId), '');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
}

/**
 * Make a built and validated candidate live, as one compensating transaction over three effects: the live
 * tree moves aside, the candidate takes its place, and the component's root-config entry is published.
 *
 * The `complete` marker and the activation journal are written and fsynced BEFORE the first rename, so a
 * crash anywhere below is recoverable — see `recoverInterruptedActivation` for the state matrix. Ordering
 * is deliberate: config is published only once the candidate is actually live, because a config entry that
 * outlives the tree it names is what makes a rejected release come back at the next restart.
 */
export async function activateCandidateApplication(
	application: Application,
	deploymentId: string,
	activation: CandidateActivation = {}
): Promise<void> {
	const liveDirPath = application.dirPath;
	const candidateDirPath = candidateApplicationPath(liveDirPath, deploymentId);
	const deploymentDirPath = candidateDeploymentDirPath(liveDirPath, deploymentId);
	const asideStagingDir = extractionStagingDirectory(liveDirPath);

	// A symlink counts: a `file:<directory>` deploy links the source rather than extracting it, and that
	// link is what gets swapped into the live path.
	const candidateStat = await lstat(candidateDirPath).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	});
	if (!candidateStat || !(candidateStat.isDirectory() || candidateStat.isSymbolicLink())) {
		throw new Error(`Cannot activate ${application.name}: no candidate build at ${candidateDirPath}`);
	}

	await markCandidateComplete(liveDirPath, deploymentId);
	const journalPath = activationJournalPath(liveDirPath, deploymentId);
	try {
		await writeControlFileDurably(
			journalPath,
			JSON.stringify({
				v: ACTIVATION_JOURNAL_VERSION,
				component: application.name,
				candidateId: deploymentId,
				publishesConfig: Boolean(activation.publishConfig),
				configBefore: activation.configBefore ?? null,
				configAfter: activation.configAfter ?? null,
			})
		);
	} catch (error) {
		// An existing journal is a retry of this same activation, not a conflict.
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}

	await ensureExtractionStagingDirectory(asideStagingDir);
	const liveExists = await lstat(liveDirPath).then(
		() => true,
		(error) => {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
			throw error;
		}
	);
	application.isNewComponent = !liveExists;

	// B1 — the live tree moves aside. It stays the rollback source until B4 retires it.
	let asidePath: string | undefined;
	let priorAbsentRecordPath: string | undefined;
	if (liveExists) {
		asidePath = join(asideStagingDir, `${IN_PROGRESS_ASIDE_PREFIX}${Date.now()}-${process.pid}-${randomUUID()}`);
		await rename(liveDirPath, asidePath);
	} else {
		priorAbsentRecordPath = join(
			asideStagingDir,
			`${IN_PROGRESS_ASIDE_PREFIX}${Date.now()}-${process.pid}-${randomUUID()}${PRIOR_ABSENT_RECORD_SUFFIX}`
		);
		await writeFile(priorAbsentRecordPath, '', { flag: 'wx', mode: 0o600 });
	}
	await syncRenameParents(liveDirPath, asidePath ?? priorAbsentRecordPath!);

	const restoreLive = async () => {
		if (asidePath) await rename(asidePath, liveDirPath);
		else if (priorAbsentRecordPath) await rm(priorAbsentRecordPath, { force: true });
		await syncRenameParents(asidePath ?? priorAbsentRecordPath!, liveDirPath);
	};

	// B2 — the candidate becomes live.
	try {
		await rename(candidateDirPath, liveDirPath);
		await syncRenameParents(candidateDirPath, liveDirPath);
	} catch (error) {
		await compensate(error, 'move the candidate into place', restoreLive, application);
		throw error;
	}

	// B3 — config is published only now, with the tree it describes already serving.
	if (activation.publishConfig) {
		try {
			await activation.publishConfig(activation.configAfter ?? null);
		} catch (error) {
			await compensate(
				error,
				'publish the component configuration',
				async () => {
					await rename(liveDirPath, candidateDirPath);
					await restoreLive();
				},
				application
			);
			throw error;
		}
	}

	// B4/B5/B6 — past the point of no return. Each of these failing leaves a state recovery settles
	// forward on the next start, so they are logged rather than thrown: the deploy has succeeded.
	const settledRecord = asidePath ?? priorAbsentRecordPath!;
	let retired = false;
	try {
		const retiredMarkerPath = await retireExtractionAside(settledRecord);
		// Retiring only MARKS the displaced tree disposable. Without this sweep the tree every deploy
		// displaces stays under `.deploy-aside/<component>` forever, so the components root grows by a
		// whole component version per deploy.
		await cleanupExtractionPaths(application, asideStagingDir, new Set([settledRecord, retiredMarkerPath]));
		retired = true;
	} catch (error) {
		application.logger.warn(`Deployed ${application.name} but could not retire its rollback record:`, error);
	}
	// The journal goes LAST, and only once the rollback record is settled. Removing it while an
	// `.in-progress-*` record still names the displaced tree would strip the evidence that this activation
	// completed, and the legacy aside recovery would then restore the OLD tree over the new one at startup.
	if (retired) {
		await rm(journalPath, { force: true }).catch((error) =>
			application.logger.warn(`Deployed ${application.name} but could not remove its activation journal:`, error)
		);
		await rm(deploymentDirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((error) =>
			application.logger.warn(`Deployed ${application.name} but could not clean up its staging directory:`, error)
		);
	}
}

/**
 * Undo an activation effect, folding a compensation failure into the original error rather than replacing
 * it — the first error is what the operator needs, the second is why the node still needs attention.
 */
async function compensate(
	error: unknown,
	what: string,
	undo: () => Promise<void>,
	application: Application
): Promise<void> {
	try {
		await undo();
	} catch (undoError) {
		throw new AggregateError(
			[error, undoError],
			`Failed to ${what} for ${application.name}: ${errorMessage(error)}; ` +
				`also failed to restore the previous version: ${errorMessage(undoError)}`
		);
	}
}

/** Remove a candidate's whole deployment directory, best-effort — it is never the last good copy. */
async function discardCandidate(application: Application, deploymentId: string): Promise<void> {
	const deploymentDirPath = candidateDeploymentDirPath(application.dirPath, deploymentId);
	await rm(deploymentDirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((error) =>
		application.logger.warn(`Failed to remove the abandoned deploy candidate at ${deploymentDirPath}:`, error)
	);
}

export async function buildCandidateApplication(application: Application, deploymentId: string): Promise<string> {
	const deploymentDirPath = candidateDeploymentDirPath(application.dirPath, deploymentId);
	const candidateDirPath = candidateApplicationPath(application.dirPath, deploymentId);
	await ensureSecureStagingDirectory(dirname(deploymentDirPath));
	await ensureSecureStagingDirectory(deploymentDirPath);
	try {
		// A candidate directory left by an earlier attempt on this same id would otherwise be extracted
		// into rather than replaced.
		await rm(candidateDirPath, { recursive: true, force: true });
		const resolved = await resolveApplicationTarball(application);
		if (resolved.kind === 'link') {
			// A `file:` directory becomes a symlink AT THE CANDIDATE PATH, so it is validated and swapped in
			// like any other candidate instead of appearing at the live path unvalidated.
			await symlink(resolved.sourceDirPath, candidateDirPath, 'dir');
		} else {
			const { tarball, tarballPath, shouldDeleteTarball } = resolved;
			try {
				await extractTarballInto(tarball, candidateDirPath, deploymentDirPath);
			} finally {
				if (!tarball.destroyed) tarball.destroy();
				if (shouldDeleteTarball && tarballPath) {
					await rm(tarballPath, { force: true }).catch((error) =>
						application.logger.warn(`Failed to remove temporary package ${tarballPath}:`, error)
					);
				}
			}
		}
		await installApplication(application, candidateDirPath);
		return candidateDirPath;
	} catch (error) {
		await discardCandidate(application, deploymentId);
		throw error;
	}
}

async function recoverOrCleanupStaleExtractionPaths(
	application: ExtractionContext,
	asideStagingDir: string
): Promise<void> {
	const entries = await readdir(asideStagingDir, { withFileTypes: true });
	const entryNames = new Set(entries.map((entry) => entry.name));
	const paths = new Set<string>(entries.map((entry) => join(asideStagingDir, entry.name)));
	const recoveryRecords = entries
		.filter(
			(entry) =>
				isExtractionRecoveryRecord(entry) &&
				entry.name.startsWith(IN_PROGRESS_ASIDE_PREFIX) &&
				!entryNames.has(`${RETIRED_ASIDE_PREFIX}${entry.name.slice(IN_PROGRESS_ASIDE_PREFIX.length)}`)
		)
		.map((entry) => ({
			entry,
			priorStateAbsent: isPriorAbsentRecoveryRecord(entry),
			timestamp: extractionAsideTimestamp(entry.name),
		}))
		.filter(({ timestamp }) => Number.isFinite(timestamp))
		.sort((left, right) => right.timestamp - left.timestamp);
	const recoveryRecord =
		recoveryRecords.find(({ priorStateAbsent }) => !priorStateAbsent) ??
		recoveryRecords.find(({ priorStateAbsent }) => priorStateAbsent);
	if (recoveryRecord) {
		const recoveryPath = join(asideStagingDir, recoveryRecord.entry.name);
		// Retire the losing candidates durably; a cleanup that fails must not let a later
		// pass adopt one of them and restore an older tree over the one recovered here.
		for (const { entry } of recoveryRecords) {
			if (entry === recoveryRecord.entry) continue;
			paths.add(await retireExtractionAside(join(asideStagingDir, entry.name)));
		}
		await rollbackExtractedDirectory(
			application,
			asideStagingDir,
			recoveryRecord.priorStateAbsent ? undefined : recoveryPath,
			paths,
			false
		);
		application.logger.warn(
			(recoveryRecord.priorStateAbsent
				? `Removed the partial ${application.name} component directory after an interrupted first deploy`
				: `Recovered the previous ${application.name} component directory after an interrupted deploy`) +
				(recoveryRecords.length > 1 ? `; discarded ${recoveryRecords.length - 1} older recovery candidates` : '')
		);
		return;
	}
	await cleanupExtractionPaths(application, asideStagingDir, paths);
}

function isPriorAbsentRecoveryRecord(entry: { isFile(): boolean; name: string }): boolean {
	return entry.isFile() && entry.name.endsWith(PRIOR_ABSENT_RECORD_SUFFIX);
}

function isExtractionRecoveryRecord(entry: {
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
	name: string;
}): boolean {
	return entry.isDirectory() || entry.isSymbolicLink() || isPriorAbsentRecoveryRecord(entry);
}

function extractionAsideTimestamp(name: string): number {
	const timestampEnd = name.indexOf('-', IN_PROGRESS_ASIDE_PREFIX.length);
	if (timestampEnd < 0) return Number.NaN;
	return Number(name.slice(IN_PROGRESS_ASIDE_PREFIX.length, timestampEnd));
}

export async function recoverInterruptedComponentExtractions(
	componentsRootDirPath: string
): Promise<Map<string, Error>> {
	const stagingRoot = join(componentsRootDirPath, ASIDE_STAGING_DIR);
	let entries;
	try {
		const stagingStat = await lstat(stagingRoot);
		if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
			throw new Error(`Component deploy staging path is not a directory: ${stagingRoot}`);
		}
		entries = await readdir(stagingRoot, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
		throw error;
	}
	const failedComponents = new Map<string, Error>();
	await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				try {
					await recoverInterruptedComponentExtraction(componentsRootDirPath, entry.name, false);
				} catch (error) {
					const recoveryError = error instanceof Error ? error : new Error(String(error));
					failedComponents.set(entry.name, recoveryError);
					const deferred = recoveryError instanceof ComponentPreparationLockTimeoutError;
					logger[deferred ? 'warn' : 'error'](
						`${deferred ? 'Deferring' : 'Not loading'} ${entry.name} because its interrupted component deployment ` +
							`${deferred ? 'is still being prepared' : 'could not be recovered'}:`,
						errorForLog(recoveryError)
					);
				}
			})
	);
	return failedComponents;
}

export async function recoverInterruptedComponentExtraction(
	componentsRootDirPath: string,
	componentName: string,
	waitForPreparation = true,
	waitTimeoutMs = COMPONENT_RECOVERY_WAIT_TIMEOUT_MS
): Promise<void> {
	const componentDirPath = join(componentsRootDirPath, componentName);
	await withComponentPreparationLock(
		componentDirPath,
		async () => {
			const asideStagingDir = extractionStagingDirectory(componentDirPath);
			try {
				await lstat(asideStagingDir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
				throw error;
			}
			await ensureExtractionStagingDirectory(asideStagingDir);
			await recoverOrCleanupStaleExtractionPaths(
				{ name: componentName, dirPath: componentDirPath, logger },
				asideStagingDir
			);
		},
		{
			timeoutMs: waitForPreparation ? waitTimeoutMs : COMPONENT_RECOVERY_TRY_TIMEOUT_MS,
			purpose: COMPONENT_RECOVERY_LOCK_PURPOSE,
			renewTimeoutWhileOwnerAlive: waitForPreparation,
			onWait: (owner) => {
				logger.info(
					`Waiting to settle component deployment state for ${componentName}` +
						(owner ? ` held by process ${owner.pid}, thread ${owner.threadId}` : '')
				);
			},
			isOwnerAlive: (owner) => owner.pid !== process.pid || isThreadRunning(owner.threadId),
		}
	);
}

export async function retireComponentExtractionStaging(
	componentDirPath: string,
	componentName = basename(componentDirPath),
	componentLogger: Logger = logger
): Promise<void> {
	const asideStagingDir = extractionStagingDirectory(componentDirPath);
	let entries;
	try {
		await lstat(asideStagingDir);
		await ensureExtractionStagingDirectory(asideStagingDir);
		entries = await readdir(asideStagingDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}
	const paths = new Set<string>(entries.map((entry) => join(asideStagingDir, entry.name)));
	for (const entry of entries) {
		if (!isExtractionRecoveryRecord(entry) || !entry.name.startsWith(IN_PROGRESS_ASIDE_PREFIX)) continue;
		const markerPath = retiredMarkerForAside(join(asideStagingDir, entry.name));
		try {
			await writeFile(markerPath, '', { flag: 'wx', mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		paths.add(markerPath);
	}
	await cleanupExtractionPaths(
		{ name: componentName, dirPath: componentDirPath, logger: componentLogger },
		asideStagingDir,
		paths
	);
}

export async function dropComponentDirectory(
	componentDirPath: string,
	componentName = basename(componentDirPath),
	componentLogger: Logger = logger
): Promise<void> {
	await retireComponentExtractionStaging(componentDirPath, componentName, componentLogger);
	const asideStagingDir = extractionStagingDirectory(componentDirPath);
	await ensureExtractionStagingDirectory(asideStagingDir);
	const droppedPath = join(asideStagingDir, `.dropped-${process.pid}-${Date.now()}-${randomUUID()}`);
	try {
		await rename(componentDirPath, droppedPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	await cleanupExtractionPaths(
		{ name: componentName, dirPath: componentDirPath, logger: componentLogger },
		asideStagingDir,
		new Set([droppedPath])
	);
}

async function cleanupExtractionPaths(
	application: ExtractionContext,
	asideStagingDir: string,
	paths: Set<string>
): Promise<void> {
	const retiredMarkers: string[] = [];
	for (const path of paths) {
		if (basename(path).startsWith(RETIRED_ASIDE_PREFIX)) {
			retiredMarkers.push(path);
			continue;
		}
		try {
			await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		} catch (error) {
			application.logger.trace?.(
				`Cleanup of previous ${application.name} component directory deferred: ${errorMessage(error)}`
			);
		}
	}
	for (const markerPath of retiredMarkers) {
		const asidePath = join(
			asideStagingDir,
			`${IN_PROGRESS_ASIDE_PREFIX}${basename(markerPath).slice(RETIRED_ASIDE_PREFIX.length)}`
		);
		try {
			await access(asidePath, constants.F_OK);
			continue;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
		}
		await rm(markerPath, { force: true }).catch((error) =>
			application.logger.trace?.(
				`Cleanup of previous ${application.name} component directory deferred: ${errorMessage(error)}`
			)
		);
	}
	await rmdir(asideStagingDir).catch((error) => {
		if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
			application.logger.trace?.(
				`Cleanup of ${application.name} deploy staging directory deferred: ${errorMessage(error)}`
			);
		}
	});
}

async function rollbackExtractedDirectory(
	application: ExtractionContext,
	asideStagingDir: string,
	asidePath: string | undefined,
	transactionPaths: Set<string>,
	retainReplacement: boolean
): Promise<void> {
	await ensureExtractionStagingDirectory(asideStagingDir);
	const retryableRenameCodes = new Set(['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES', 'EBUSY']);
	const displaceCurrentDirectorySync = (): string | undefined => {
		const displacedPath = join(asideStagingDir, `.failed-${process.pid}-${Date.now()}-${randomUUID()}`);
		try {
			renameSync(application.dirPath, displacedPath);
			transactionPaths.add(displacedPath);
			return displacedPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
			throw error;
		}
	};
	const displaceCurrentDirectory = async (): Promise<string | undefined> => {
		const retryDeadline = Date.now() + 5000;
		let lastError: unknown;
		do {
			const displacedPath = join(asideStagingDir, `.failed-${process.pid}-${Date.now()}-${randomUUID()}`);
			try {
				await rename(application.dirPath, displacedPath);
				transactionPaths.add(displacedPath);
				return displacedPath;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === 'ENOENT') return undefined;
				if (!retryableRenameCodes.has(code ?? '')) throw error;
				lastError = error;
				await delay(10);
			}
		} while (Date.now() < retryDeadline);
		throw lastError;
	};

	if (asidePath) {
		const asideIsSymbolicLink = (await lstat(asidePath)).isSymbolicLink();
		let restoreError: unknown;
		let restoreRetryDeadline: number | undefined;
		let fallbackDisplacedPath: string | undefined;
		let placeholderIdentity = await identifyRollbackPlaceholder(application.dirPath);
		const failRestore = async (error: unknown): Promise<never> => {
			try {
				await makeRollbackPlaceholderMovable(application.dirPath, placeholderIdentity);
				if (retainReplacement && fallbackDisplacedPath) {
					const fallbackRetryDeadline = Date.now() + 5000;
					let fallbackRestoreError: unknown;
					do {
						let writerDisplacedPath: string | undefined;
						try {
							writerDisplacedPath = displaceCurrentDirectorySync();
							placeholderIdentity = undefined;
							renameSync(fallbackDisplacedPath, application.dirPath);
							fallbackRestoreError = undefined;
						} catch (restoreFallbackError) {
							fallbackRestoreError = restoreFallbackError;
						}
						if (writerDisplacedPath) {
							await rm(writerDisplacedPath, {
								recursive: true,
								force: true,
								maxRetries: 3,
								retryDelay: 100,
							});
							transactionPaths.delete(writerDisplacedPath);
						}
						if (
							fallbackRestoreError &&
							!retryableRenameCodes.has((fallbackRestoreError as NodeJS.ErrnoException).code ?? '')
						) {
							throw fallbackRestoreError;
						}
						if (fallbackRestoreError) {
							await delay(10);
						} else {
							break;
						}
					} while (Date.now() < fallbackRetryDeadline);
					if (fallbackRestoreError) throw fallbackRestoreError;
					transactionPaths.delete(fallbackDisplacedPath);
					transactionPaths.add(await retireExtractionAside(asidePath));
				}
				if (placeholderIdentity) {
					try {
						const current = await lstat(application.dirPath, { bigint: true });
						if (current.dev === placeholderIdentity.dev && current.ino === placeholderIdentity.ino) {
							await rm(application.dirPath, {
								recursive: true,
								force: true,
								maxRetries: 3,
								retryDelay: 100,
							});
							placeholderIdentity = undefined;
						}
					} catch (placeholderError) {
						if ((placeholderError as NodeJS.ErrnoException).code !== 'ENOENT') throw placeholderError;
					}
				}
				const disposablePaths = new Set(transactionPaths);
				disposablePaths.delete(asidePath);
				await cleanupExtractionPaths(application, asideStagingDir, disposablePaths);
			} catch (fallbackError) {
				throw new AggregateError(
					[error, fallbackError],
					`Failed to restore either the previous or replacement ${application.name} component directory`
				);
			}
			throw new Error(
				`Failed to restore ${asidePath} to the live component directory ${application.dirPath}: ${errorMessage(error)}`,
				{ cause: error }
			);
		};
		do {
			try {
				if (placeholderIdentity) {
					const current = lstatSync(application.dirPath, { bigint: true });
					if (current.dev === placeholderIdentity.dev && current.ino === placeholderIdentity.ino) {
						chmodSync(application.dirPath, 0o700);
						renameSync(asidePath, application.dirPath);
					} else {
						placeholderIdentity = undefined;
						await rename(asidePath, application.dirPath);
					}
				} else {
					await rename(asidePath, application.dirPath);
				}
				transactionPaths.delete(asidePath);
				await cleanupExtractionPaths(application, asideStagingDir, transactionPaths);
				return;
			} catch (error) {
				restoreError = error;
				if (!retryableRenameCodes.has((error as NodeJS.ErrnoException).code ?? '')) {
					return failRestore(error);
				}
				let displacedPath: string | undefined;
				const displacedPlaceholderIdentity = placeholderIdentity;
				try {
					await makeRollbackPlaceholderMovable(application.dirPath, placeholderIdentity);
					displacedPath = await displaceCurrentDirectory();
					placeholderIdentity = undefined;
					if (displacedPath && displacedPlaceholderIdentity) {
						try {
							const displaced = await lstat(displacedPath, { bigint: true });
							if (
								displaced.dev === displacedPlaceholderIdentity.dev &&
								displaced.ino === displacedPlaceholderIdentity.ino
							) {
								const displacedPlaceholderPath = displacedPath;
								displacedPath = undefined;
								await rm(displacedPlaceholderPath, {
									recursive: true,
									force: true,
									maxRetries: 3,
									retryDelay: 100,
								});
								transactionPaths.delete(displacedPlaceholderPath);
							}
						} catch (placeholderCleanupError) {
							application.logger.trace?.(
								`Cleanup of the ${application.name} rollback placeholder deferred: ${errorMessage(placeholderCleanupError)}`
							);
						}
					}
				} catch (displaceError) {
					return failRestore(
						new AggregateError(
							[error, displaceError],
							`Failed to clear the live ${application.name} component directory for rollback`
						)
					);
				}
				if (displacedPath) {
					if (fallbackDisplacedPath) {
						try {
							await rm(displacedPath, {
								recursive: true,
								force: true,
								maxRetries: 3,
								retryDelay: 100,
							});
							transactionPaths.delete(displacedPath);
						} catch (cleanupError) {
							return failRestore(
								new AggregateError(
									[error, cleanupError],
									`Failed to discard a displaced ${application.name} writer directory during rollback`
								)
							);
						}
					} else {
						fallbackDisplacedPath = displacedPath;
					}
				}
				restoreRetryDeadline ??= Date.now() + 5000;
				if (process.platform !== 'win32' && process.getuid?.() !== 0) {
					const stagedPlaceholderPath = join(
						asideStagingDir,
						`.rollback-placeholder-${process.pid}-${Date.now()}-${randomUUID()}`
					);
					try {
						if (asideIsSymbolicLink) {
							await writeFile(stagedPlaceholderPath, '', { flag: 'wx', mode: 0o000 });
						} else {
							await mkdir(stagedPlaceholderPath, { mode: 0o300 });
						}
						transactionPaths.add(stagedPlaceholderPath);
						let placeholderPlacementError: unknown;
						do {
							let writerDisplacedPath: string | undefined;
							try {
								writerDisplacedPath = displaceCurrentDirectorySync();
								renameSync(stagedPlaceholderPath, application.dirPath);
								if (!asideIsSymbolicLink) {
									try {
										chmodSync(application.dirPath, 0o100);
									} catch (chmodError) {
										try {
											renameSync(application.dirPath, stagedPlaceholderPath);
										} catch (compensationError) {
											throw new AggregateError(
												[chmodError, compensationError],
												`Failed to restrict and then restore the ${application.name} rollback placeholder`
											);
										}
										throw chmodError;
									}
								}
								transactionPaths.delete(stagedPlaceholderPath);
								placeholderPlacementError = undefined;
							} catch (placeholderError) {
								placeholderPlacementError = placeholderError;
							}
							if (writerDisplacedPath) {
								await rm(writerDisplacedPath, {
									recursive: true,
									force: true,
									maxRetries: 3,
									retryDelay: 100,
								});
								transactionPaths.delete(writerDisplacedPath);
							}
							if (
								placeholderPlacementError &&
								!retryableRenameCodes.has((placeholderPlacementError as NodeJS.ErrnoException).code ?? '')
							) {
								throw placeholderPlacementError;
							}
							if (!placeholderPlacementError) break;
							await delay(10);
						} while (Date.now() < restoreRetryDeadline);
						if (transactionPaths.has(stagedPlaceholderPath)) {
							throw new Error(
								`Failed to place the ${application.name} rollback placeholder before the deadline: ${errorMessage(placeholderPlacementError)}`,
								{ cause: placeholderPlacementError }
							);
						}
						const placeholder = await lstat(application.dirPath, { bigint: true });
						placeholderIdentity = { dev: placeholder.dev, ino: placeholder.ino };
					} catch (placeholderError) {
						return failRestore(
							new AggregateError(
								[error, placeholderError],
								`Failed to block a live ${application.name} writer during rollback`
							)
						);
					}
				}
				await delay(10);
			}
		} while (restoreRetryDeadline !== undefined && Date.now() < restoreRetryDeadline);
		return failRestore(restoreError);
	}
	try {
		await displaceCurrentDirectory();
	} catch (displaceError) {
		try {
			await rm(application.dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			await cleanupExtractionPaths(application, asideStagingDir, transactionPaths);
			return;
		} catch (removeError) {
			throw new AggregateError(
				[displaceError, removeError],
				`Failed to remove the partial ${application.name} component directory after extraction failed`
			);
		}
	}
	await cleanupExtractionPaths(application, asideStagingDir, transactionPaths);
}

/**
 * Install an application to its relative `application.dirPath` using either a
 * configured `application.install` command, a derived package manager from the
 * application's `package.json#devEngines`, or falling back to the default
 * package manager, `npm`.
 *
 * Will return early if `node_modules` already exists within the `application.dirPath`
 *
 * This method may be called from any Harper thread as part of a serialized preparation.
 */
/**
 * Install a component's dependencies. `buildDirPath` is where the tree being installed lives — the live
 * path today, or a candidate under `.deploy-staging` when the deploy builds off to the side. Passed
 * explicitly rather than by temporarily repointing `application.dirPath`, because that property is read
 * after preparation too and any path that skipped the restore would leave it naming a directory that no
 * longer exists.
 */
export async function installApplication(application: Application, buildDirPath = application.dirPath) {
	let packageJSON: any;
	try {
		packageJSON = JSON.parse(await readFile(join(buildDirPath, 'package.json'), 'utf8'));
	} catch (err) {
		if (err.code !== 'ENOENT') throw err;
		// If no package.json, nothing to install
		application.logger.info(`Application ${application.name} has no package.json; skipping install`);
		return;
	}
	try {
		// Does node_modules exist?
		await access(join(buildDirPath, 'node_modules'), constants.F_OK);
		application.logger.info(
			`Application ${application.name} already has node_modules; skipping install and treating the runtime as opaque for redeploy comparison`
		);
		application.installationIsOpaque = true;
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
			buildDirPath,
			application.install?.timeout,
			customOnLine,
			application.npmUserconfigPath
		);
		// if it succeeds, return
		if (code === 0) {
			application.installationIsOpaque = true;
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
			buildDirPath,
			application.install?.timeout,
			pmOnLine,
			application.npmUserconfigPath
		);

		// if it succeeds, return
		if (code === 0) {
			if (application.install?.allowInstallScripts) application.installationIsOpaque = true;
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
		buildDirPath,
		application.install?.timeout,
		npmOnLine,
		application.npmUserconfigPath
	);

	// if it succeeds, return
	if (code === 0) {
		if (application.install?.allowInstallScripts) application.installationIsOpaque = true;
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
	// Existing components rely on their runtime-equivalence checks; only a first deploy restarts unconditionally.
	isNewComponent: boolean = true;
	packageMetadataChanged: boolean = false;
	installationIsOpaque: boolean = false;

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
 * This method may be called from any Harper thread. Same-component calls are serialized across
 * threads by the preparation lock below.
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
export type PrepareApplicationOptions = {
	/**
	 * Runs against the built candidate while the live version is still serving, and BEFORE the swap. A
	 * throw here means the candidate never goes live — which is the whole difference from the previous
	 * behavior, where the swap committed first and a load failure was reported over an already-live
	 * broken release.
	 */
	validateCandidate?: (candidateDirPath: string) => Promise<void>;
	/**
	 * Reads this component's CURRENT root-config entry, so a failed activation can put it back. A reader
	 * rather than a value: it is called under the component preparation lock, at journal time, so a deploy
	 * queued behind another one records the entry that one actually committed instead of a snapshot taken
	 * before it ran.
	 */
	readConfigEntry?: () => Record<string, any> | null;
	/** What the entry must say once the candidate is live; `null` removes it. */
	configAfter?: Record<string, any> | null;
	/**
	 * Publishes an entry. Omitted by boot, which already starts FROM authoritative config and so must
	 * neither republish nor compensate it.
	 */
	publishConfig?: (entry: Record<string, any> | null) => Promise<void>;
};

export async function prepareApplication(application: Application, options: PrepareApplicationOptions = {}) {
	const deploymentId = await broadcastDeployStart(application.name);
	try {
		const commandTimeoutMs = application.install?.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS;
		await withComponentPreparationLock(
			application.dirPath,
			async () => {
				const asideStagingDir = extractionStagingDirectory(application.dirPath);
				let recoveryPending = true;
				try {
					await lstat(asideStagingDir);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
					recoveryPending = false;
				}
				if (recoveryPending) {
					await ensureExtractionStagingDirectory(asideStagingDir);
					await recoverOrCleanupStaleExtractionPaths(application, asideStagingDir);
				}
				const previousPackageMetadata = await readInstalledPackageMetadata(application.dirPath);
				// Determined before the swap, because both trees exist then: the runtime comparison below
				// wants the live version and the candidate side by side.
				application.isNewComponent = !(await lstat(application.dirPath).then(
					() => true,
					(error) => {
						if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
						throw error;
					}
				));
				try {
					// Materialize the per-deploy `.npmrc` before the build so both `npm pack` and `npm install`
					// authenticate against the private registry; always remove it afterward.
					await application.writeTransientNpmrc();
					let candidateDirPath: string;
					try {
						// The git credential socket only has to be up for extraction — that is where npm resolves and
						// clones a git-reference package. Closing it before the install means the credential is
						// already gone by the time the component's dependency tree (and any install script it is
						// allowed to run) executes.
						await application.startGitCredentialSession();
						candidateDirPath = await buildCandidateApplication(application, deploymentId);
					} finally {
						await application.cleanupGitCredentialSession();
					}
					try {
						// Validated while the previous version is still the one serving, so a candidate that
						// installs cleanly but throws at load is rejected without ever having been live.
						await options.validateCandidate?.(candidateDirPath);
						if (!application.isNewComponent) {
							application.packageMetadataChanged = installedRuntimeChanged(
								previousPackageMetadata,
								await readInstalledPackageMetadata(candidateDirPath),
								application.installationIsOpaque
							);
						}
						await activateCandidateApplication(application, deploymentId, {
							configBefore: options.readConfigEntry?.() ?? null,
							configAfter: options.configAfter,
							publishConfig: options.publishConfig,
						});
					} catch (error) {
						// The builder's own cleanup only covers a failed BUILD. A rejected validation (or a
						// compensated activation) would otherwise leave a whole installed dependency tree under
						// this deployment id, so repeated rejections fill the component volume.
						await discardCandidate(application, deploymentId);
						throw error;
					}
				} finally {
					await application.cleanupTransientNpmrc();
				}
			},
			{
				// The longest extraction path runs clone, tag listing, checkout, and npm pack. A custom
				// package manager configured to warn can then fall back to npm, yielding two install
				// commands. Bound orphaned same-process worker locks without rejecting behind a valid holder.
				timeoutMs:
					MAX_GIT_EXTRACTION_COMMANDS * DEFAULT_COMMAND_TIMEOUT_MS +
					MAX_INSTALL_COMMANDS * commandTimeoutMs +
					COMPONENT_PREPARATION_WAIT_MARGIN_MS,
				onWait: (owner) =>
					application.logger.info(
						`Waiting for in-progress preparation of ${application.name}` +
							(owner ? ` held by process ${owner.pid}, thread ${owner.threadId}` : '')
					),
				onReleaseError: (error) =>
					application.logger.error(
						`Failed to release the component preparation lock for ${application.name}:`,
						errorForLog(error)
					),
				isOwnerAlive: (owner) => owner.pid !== process.pid || isThreadRunning(owner.threadId),
			}
		);
	} finally {
		broadcastDeployEnd(application.name, deploymentId);
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
			// Once preparation is required, the old entry is no longer evidence of a complete
			// installation. In particular, a failed reinstall may leave a partial directory behind;
			// retaining the prior entry would make the next boot skip that partial component.
			applicationInstallationPromises.push(
				recordApplicationPreparation(
					harperApplicationLock,
					name,
					applicationConfig,
					() => prepareApplication(application),
					(lock) => persistApplicationLock(harperApplicationLockPath, lock)
				)
			);
		} catch (error) {
			logger.error?.(`Skipping installation of application ${name} due to invalid configuration: ${error.message}`);
		}
	}

	const applicationInstallationStatuses = await Promise.allSettled(applicationInstallationPromises);
	logger.debug?.(applicationInstallationStatuses);
	logger.info?.('All root applications loaded');

	// Finally, write the lock file. Every component that went through recordApplicationPreparation
	// already persisted its own transition durably; this covers components that were skipped
	// (matching-config, already installed) and never mutated the in-memory object at all.
	await persistApplicationLock(harperApplicationLockPath, harperApplicationLock);
}

// Concurrent components each persist the same shared lock file. Serialize per path so two
// writers never race the same temp filename, and so a write always reflects the latest merged
// in-memory state rather than a stale snapshot silently clobbering a sibling's just-written change.
const applicationLockWriteQueues = new Map<string, Promise<void>>();

async function persistApplicationLock(
	harperApplicationLockPath: string,
	harperApplicationLock: { applications: Record<string, ApplicationConfig> }
): Promise<void> {
	const previous = applicationLockWriteQueues.get(harperApplicationLockPath) ?? Promise.resolve();
	const next = previous
		.catch(() => {})
		.then(async () => {
			const tempPath = `${harperApplicationLockPath}.${process.pid}.${randomUUID()}.tmp`;
			await writeFile(tempPath, JSON.stringify(harperApplicationLock, null, 2), 'utf8');
			await rename(tempPath, harperApplicationLockPath);
		});
	applicationLockWriteQueues.set(harperApplicationLockPath, next);
	await next;
}

/**
 * Keep the boot-time application lock honest while a reinstall is in flight. Factored as an
 * explicit production seam so the failure transition can be tested without replacing module
 * bindings: a stale success is removed before preparation starts and restored only on success.
 *
 * `persist` is durably awaited on both transitions — not just applied in memory — so a crash
 * mid-preparation can never leave the on-disk lock file still claiming success for a directory a
 * subsequent reinstall left partially written (which would make `installApplications`'s
 * already-installed check at the top of this loop skip the required reinstall forever).
 */
export async function recordApplicationPreparation(
	harperApplicationLock: { applications: Record<string, ApplicationConfig> },
	name: string,
	applicationConfig: ApplicationConfig,
	prepare: () => Promise<void>,
	persist: (lock: { applications: Record<string, ApplicationConfig> }) => Promise<void> = async () => {}
): Promise<void> {
	delete harperApplicationLock.applications[name];
	await persist(harperApplicationLock);
	try {
		await prepare();
		harperApplicationLock.applications[name] = applicationConfig;
		await persist(harperApplicationLock);
	} catch (error) {
		logger.error?.(`Failed to prepare application ${name}:`, errorForLog(error));
		throw error;
	}
}

/**
 * Rewrite every occurrence of `sshDir` in an ssh `config` file's contents to `tempDir`, matching
 * either slash direction per path segment (and case-insensitively on `win32`) rather than relying
 * on the two strings being byte-identical.
 *
 * A plain string substitution (`sshConfig.split(sshDir).join(tempDir)`) doesn't hold
 * cross-platform: ssh config files are frequently forward-slash even on Windows, while `sshDir`
 * (built via `path.join`) is backslash there, so the split would silently never match; Windows
 * paths are also case-insensitive. `sshDir` is split into segments on either separator *before*
 * escaping, so escaping a regex-special character within a segment (e.g. a literal paren in a
 * directory name) can't interact with the separator substitution. A trailing lookahead keeps
 * `sshDir` from partial-matching a sibling directory whose name happens to start with it (e.g.
 * `.../ssh` vs `.../sshhh`).
 *
 * Exported only so unit tests can pin the Windows-path behavior (mixed slash direction, case
 * insensitivity) directly via the `platform` override, without needing to run on Windows.
 */
export function rewriteSshConfigPaths(
	sshConfig: string,
	sshDir: string,
	tempDir: string,
	platform: string = process.platform
): string {
	const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const sepClass = '[\\\\/]';
	const sshDirPattern = sshDir.split(/[\\/]/).map(escapeRegExp).join(sepClass) + `(?=${sepClass}|$)`;
	const sshDirRegex = new RegExp(sshDirPattern, platform === 'win32' ? 'gi' : 'g');
	const normalizedTempDir = platform === 'win32' ? tempDir.replace(/\\/g, '/') : tempDir;
	// Function replacer: a string replacer would treat `$` sequences in normalizedTempDir
	// (e.g. `$&`, `$1`) as replacement patterns instead of literal characters.
	return sshConfig.replace(sshDirRegex, () => normalizedTempDir);
}

/**
 * Materialize the SSH deploy keys for the lifetime of a single git-over-SSH spawn.
 *
 * Keys are sealed at rest as `enc:v1:` envelopes (Harper Pro's `add_ssh_key`), but ssh needs a key
 * *file*, so each key is decrypted into a fresh 0700 temp dir as a 0600 file and the ssh config is
 * copied with its `IdentityFile` paths repointed at the transient copies. The caller removes the
 * dir as soon as the spawn settles, so the plaintext never outlives the git invocation. Legacy
 * plaintext keys (written before sealing, or on a node with no custody) are copied through
 * unchanged, so this is a no-op for them beyond the temp dir.
 *
 * A key that cannot be decrypted — no custody registered on this node, an envelope sealed under a
 * different cluster key, or a tampered envelope — is logged and skipped rather than failing the
 * spawn: a deploy that doesn't need that key is unaffected, and one that does fails with the usual
 * SSH auth error (see `isSSHAuthFailure`). No log or error message here carries key material or
 * the envelope.
 *
 * @returns The `GIT_SSH_COMMAND` to use plus its cleanup, or undefined when no keys are configured.
 */
export async function materializeGitSSH(): Promise<{ command: string; cleanup: () => Promise<void> } | undefined> {
	const rootDir = getConfigValue(CONFIG_PARAMS.ROOTPATH);
	if (!rootDir) return; // config not initialized (e.g. an install-time spawn) — no ssh dir to read
	const sshDir = join(rootDir, 'ssh');
	// `withFileTypes` so a stray subdirectory in the ssh dir (e.g. one named `foo.key`) is filtered
	// out here rather than reaching `readFile` below and throwing EISDIR, which would abort the
	// whole spawn instead of just skipping that one entry.
	const sshDirEntries = await readdir(sshDir, { withFileTypes: true }).catch(() => undefined);
	if (!sshDirEntries) return; // no ssh dir on this node
	const keyFiles = sshDirEntries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.key'))
		.map((entry) => entry.name);
	if (keyFiles.length === 0) return;

	const tempDir = await mkdtemp(join(tmpdir(), 'harper-ssh-'));
	const cleanup = async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch (error) {
			// never mask the caller's error (this runs from a finally) — a leaked temp dir is the
			// lesser failure, and it holds only 0600 files in a 0700 dir
			logger.warn?.(`Failed to remove transient ssh dir ${tempDir}:`, error);
		}
	};

	try {
		const decryptor = getSecretDecryptor();
		for (const keyFile of keyFiles) {
			let storedKey: string;
			try {
				storedKey = await readFile(join(sshDir, keyFile), 'utf8');
			} catch (error) {
				// Same fail-open policy as a decrypt failure below: a key that can't even be read
				// (permission drift, deleted mid-scan by a concurrent add_ssh_key/rotation, a
				// transient EIO) should drop that one key, not abort a spawn that may not need it.
				logger.error?.(`Failed to read SSH key ${keyFile}: ${(error as Error).message}; skipping it`);
				continue;
			}
			let keyMaterial = storedKey;
			if (storedKey.startsWith(ENV_ENCRYPTED_PREFIX)) {
				if (!decryptor) {
					logger.error?.(
						`SSH key ${keyFile} is encrypted but no secret custody is registered on this node; skipping it`
					);
					continue;
				}
				try {
					keyMaterial = decryptor(storedKey);
				} catch (error) {
					logger.error?.(`Failed to decrypt SSH key ${keyFile}: ${(error as Error).message}; skipping it`);
					continue;
				}
			}
			await writeFile(join(tempDir, keyFile), keyMaterial, { mode: 0o600 });
		}
		// The config's `IdentityFile` lines are absolute paths into the durable ssh dir; repoint
		// them at the transient copies. known_hosts holds no secrets and stays where it is.
		const sshConfig = await readFile(join(sshDir, 'config'), 'utf8').catch(() => '');
		const rewrittenConfig = rewriteSshConfigPaths(sshConfig, sshDir, tempDir);
		await writeFile(join(tempDir, 'config'), rewrittenConfig, { mode: 0o600 });
	} catch (error) {
		await cleanup();
		throw error;
	}

	return {
		command: `ssh -F ${join(tempDir, 'config')} -o UserKnownHostsFile=${join(sshDir, 'known_hosts')}`,
		cleanup,
	};
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

/**
 * Run a command with the deploy's SSH key material materialized only for the duration of the
 * spawn. The keys are decrypted to a transient 0700 dir (see `materializeGitSSH`) and removed as
 * soon as the process settles — on success, failure, and timeout alike.
 */
export async function nonInteractiveSpawn(
	applicationName: string,
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
	onLine?: (stream: 'stdout' | 'stderr', line: string) => void,
	npmUserconfigPath?: string,
	gitCredentialEnv?: Record<string, string>
): Promise<{ stdout: string; stderr: string; code: number }> {
	const gitSSH = await materializeGitSSH();
	try {
		return await spawnWithEnv(
			applicationName,
			command,
			args,
			cwd,
			timeoutMs,
			onLine,
			npmUserconfigPath,
			gitSSH?.command,
			gitCredentialEnv
		);
	} finally {
		await gitSSH?.cleanup();
	}
}

function spawnWithEnv(
	applicationName: string,
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	onLine: ((stream: 'stdout' | 'stderr', line: string) => void) | undefined,
	npmUserconfigPath: string | undefined,
	gitSSHCommand: string | undefined,
	gitCredentialEnv: Record<string, string> | undefined
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		logger
			.loggerWithTag(`${applicationName}:spawn:${command}`)
			.debug?.(`Executing \`${command} ${args.join(' ')}\` in ${cwd}`);

		const env = { ...process.env };

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
			// A dedicated POSIX process group lets a timeout terminate npm plus every reify worker
			// and install-script descendant before the component preparation lock is released.
			detached: process.platform !== 'win32',
		});
		const trackedProcessId = childProcess.pid;
		if (trackedProcessId) registerProcessGroup(trackedProcessId);
		let processGroupIsTracked = Boolean(trackedProcessId);
		const untrackProcessGroup = () => {
			if (!processGroupIsTracked || !trackedProcessId) return;
			processGroupIsTracked = false;
			unregisterProcessGroup(trackedProcessId);
		};

		let didTimeout = false;
		let didSettle = false;
		let resolveClose: () => void;
		const closePromise = new Promise<void>((resolve) => {
			resolveClose = resolve;
		});
		const timeout = setTimeout(() => {
			didTimeout = true;
			void terminateProcessTree(childProcess, closePromise).then(
				() => {
					// Only untrack once terminateProcessTree has confirmed the group is actually gone.
					// The direct child can emit 'close' mid-grace-period (e.g. right after SIGTERM)
					// while a same-group descendant is still alive; untracking there instead would let
					// a worker exit in that window forget the group before it's truly empty.
					untrackProcessGroup();
					if (didSettle) return;
					didSettle = true;
					reject(new CommandTimeoutError(command, args, timeoutMs));
				},
				(error) => {
					untrackProcessGroup();
					if (didSettle) return;
					didSettle = true;
					reject(new CommandTimeoutError(command, args, timeoutMs, error));
				}
			);
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

		let didFlushOutput = false;
		const flushOutput = () => {
			if (didFlushOutput) return;
			didFlushOutput = true;
			stdoutSplitter?.flush();
			stderrSplitter?.flush();
		};

		childProcess.on('error', (error) => {
			clearTimeout(timeout);
			// See the 'close' handler: when didTimeout is true, the timeout path's own
			// terminateProcessTree(...).then(...) owns untracking, only once it confirms the group is
			// gone. Untracking here too could forget the group while that confirmation is still pending.
			if (!didTimeout) untrackProcessGroup();
			flushOutput();
			// Print out stderr before rejecting
			if (stderr) {
				printStd(applicationName, command, stderr, 'stderr');
			}
			if (!didTimeout && !didSettle) {
				didSettle = true;
				reject(error);
			}
		});

		childProcess.on('close', async (code) => {
			resolveClose();
			clearTimeout(timeout);
			// A successful direct-child exit does not prove the process group is empty: a custom
			// installer can spawn-and-unref a descendant that inherits the group and outlives its
			// parent (same invariant terminateProcessTree enforces on the timeout path). Confirm/
			// terminate the whole group before letting the caller treat this command as done, or a
			// survivor could keep mutating node_modules after the component lock is released. Skip
			// when a timeout is already driving its own terminateProcessTree call for this process.
			if (!didTimeout && trackedProcessId) {
				try {
					await terminateProcessTree(childProcess, closePromise);
				} catch (error) {
					untrackProcessGroup();
					flushOutput();
					if (!didSettle) {
						didSettle = true;
						reject(error);
					}
					return;
				}
				untrackProcessGroup();
			}
			// When didTimeout is true, the timeout path's own terminateProcessTree(...).then(...) owns
			// untracking (only once it confirms the group is gone) — untracking here too, before that
			// confirmation lands, is exactly the premature-forget race described above.
			// Flush any trailing partial lines so the caller sees process output that didn't
			// end on a newline (some package managers do this on their final progress line).
			flushOutput();
			if (stderr) {
				printStd(applicationName, command, stderr, 'stderr');
			}
			logger.loggerWithTag(`${applicationName}:spawn:${command}`).debug?.(`Process exited with code ${code}`);
			if (didTimeout || didSettle) return;
			didSettle = true;
			resolve({
				stdout,
				stderr,
				code,
			});
		});
	});
}

const PROCESS_TERMINATION_GRACE_MS = 5000;
const PROCESS_TERMINATION_POLL_MS = 25;
const PROCESS_CLOSE_WAIT_MS = 5000;

class CommandTimeoutError extends Error {
	statusCode = 500;
	constructor(command: string, args: string[], timeoutMs: number, cause?: unknown) {
		super(`Command \`${command} ${args.join(' ')}\` timed out after ${timeoutMs}ms`, { cause });
		this.name = 'CommandTimeoutError';
	}
}

function processGroupIsAlive(processGroupId: number): boolean {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error: any) {
		return error.code === 'EPERM';
	}
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
	const deadline = performance.now() + timeoutMs;
	while (processGroupIsAlive(processGroupId)) {
		if (performance.now() >= deadline) return false;
		await delay(PROCESS_TERMINATION_POLL_MS);
	}
	return true;
}

/**
 * Wait until the caller can positively establish that a timed-out process tree is gone. There is
 * deliberately no deadline: releasing the component lock while a descendant can still resume and
 * mutate node_modules is less safe than keeping that deployment wedged for operator intervention.
 */
export async function waitForConfirmedTermination(
	isAlive: () => boolean | Promise<boolean>,
	pollMs: number = PROCESS_TERMINATION_POLL_MS
): Promise<void> {
	while (await isAlive()) await delay(pollMs);
}

export async function waitForWindowsTreeTermination(
	attemptTermination: () => boolean | Promise<boolean>,
	treeIsAlive: () => boolean | null | Promise<boolean | null>,
	pollMs: number = PROCESS_TERMINATION_POLL_MS
): Promise<void> {
	for (;;) {
		// A successful taskkill exit only proves the request was accepted, not that the whole tree
		// has actually exited — Windows termination is asynchronous, and taskkill can report overall
		// success even when a descendant is not yet (or never) reaped. Only an explicit `false` from
		// treeIsAlive, independently confirming no member of the tree remains, is safe to return on;
		// `true` or `null` (unknown) must keep the loop retrying.
		await attemptTermination();
		if ((await treeIsAlive()) === false) return;
		await delay(pollMs);
	}
}

async function windowsProcessTreeIsAlive(rootPid: number): Promise<boolean | null> {
	// Query the process table rather than probing only the parent PID: descendants retain their
	// ParentProcessId after the parent exits, which is exactly the taskkill "process not found" race.
	// Exit code 1 must mean "queried the process table and positively found nothing" — never
	// "the query itself failed" (e.g. Get-CimInstance denied or WMI unavailable), which would
	// otherwise read identically to a confirmed-gone tree and release the lock while a descendant
	// may still be alive. ErrorActionPreference=Stop plus the wrapping try/catch turns a query
	// failure into its own exit code (2), which the caller below already treats as unknown.
	const script =
		"$ErrorActionPreference = 'Stop'; try { " +
		`$rootPid = ${rootPid}; ` +
		'$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); ' +
		'$frontier = @($rootPid); $seen = @{}; $found = $false; ' +
		'while ($frontier.Count -gt 0) { ' +
		'$next = @(); foreach ($parentPid in $frontier) { if ($seen[$parentPid]) { continue }; ' +
		'$seen[$parentPid] = $true; foreach ($p in $all) { ' +
		'if ($p.ProcessId -eq $parentPid) { $found = $true }; ' +
		'if ($p.ParentProcessId -eq $parentPid) { $found = $true; $next += [int]$p.ProcessId } } }; ' +
		'$frontier = $next }; ' +
		'if ($found) { exit 0 } else { exit 1 } ' +
		'} catch { exit 2 }';
	return new Promise<boolean | null>((resolve) => {
		const query = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
			stdio: 'ignore',
			windowsHide: true,
		});
		query.once('close', (code) => resolve(code === 0 ? true : code === 1 ? false : null));
		query.once('error', () => resolve(null));
	});
}

async function terminateWindowsProcessTree(childProcess: ChildProcess): Promise<void> {
	if (!childProcess.pid) return;
	const rootPid = childProcess.pid;
	await waitForWindowsTreeTermination(
		() =>
			new Promise<boolean>((resolve) => {
				const taskkill = spawn('taskkill', ['/pid', String(rootPid), '/T', '/F'], {
					stdio: 'ignore',
					windowsHide: true,
				});
				taskkill.once('close', (code) => resolve(code === 0));
				taskkill.once('error', () => resolve(false));
			}),
		() => windowsProcessTreeIsAlive(rootPid)
	);
}

async function waitForProcessClose(childProcess: ChildProcess, closePromise: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout>;
	const closeTimeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), PROCESS_CLOSE_WAIT_MS);
		timer.unref?.();
	});
	const closed = await Promise.race([closePromise.then(() => true), closeTimeout]);
	clearTimeout(timer!);
	if (!closed) {
		// A detached descendant can retain inherited pipe descriptors after its process tree was
		// terminated. Stop waiting on those descriptors so a bounded command timeout remains bounded.
		childProcess.stdout?.destroy();
		childProcess.stderr?.destroy();
	}
}

export async function terminateProcessTree(childProcess: ChildProcess, closePromise: Promise<void>): Promise<void> {
	if (!childProcess.pid) {
		await waitForProcessClose(childProcess, closePromise);
		return;
	}
	if (process.platform === 'win32') {
		await terminateWindowsProcessTree(childProcess);
		await waitForProcessClose(childProcess, closePromise);
		return;
	}

	// The direct child's exit does not prove the process group is empty: a custom installer can
	// spawn-and-unref a descendant that inherits the group and outlives its parent. Probe the group
	// itself rather than trusting childProcess.exitCode/signalCode.
	const processGroupId = childProcess.pid;
	if (!processGroupIsAlive(processGroupId)) {
		await waitForProcessClose(childProcess, closePromise);
		return;
	}
	try {
		process.kill(-processGroupId, 'SIGTERM');
	} catch (error: any) {
		if (error.code !== 'ESRCH') throw error;
	}
	if (!(await waitForProcessGroupExit(processGroupId, PROCESS_TERMINATION_GRACE_MS))) {
		try {
			process.kill(-processGroupId, 'SIGKILL');
		} catch (error: any) {
			if (error.code !== 'ESRCH') throw error;
		}
		await waitForConfirmedTermination(() => processGroupIsAlive(processGroupId));
	}
	await waitForProcessClose(childProcess, closePromise);
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
