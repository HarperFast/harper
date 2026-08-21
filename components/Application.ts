import { type Logger } from '../utility/logging/logger.ts';
import {
	addConfig,
	deleteConfigFromFile,
	getConfigObj,
	getConfigValue,
	getConfigPath,
	readConfigFile,
} from '../config/configUtils.ts';
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

import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import {
	access,
	chmod,
	constants,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	rmdir,
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
// during a deploy swap (see activateStagedApplication). The leading dot keeps
// loadComponentDirectories from loading its contents as components.
export const ASIDE_STAGING_DIR = '.deploy-aside';
const IN_PROGRESS_ASIDE_PREFIX = '.in-progress-';
// Parked and known-disposable at park time (an evicted two-deploys-ago retained-previous). NEVER a
// recovery candidate — see discardDirAside for why the distinction has to be in the name.
export const DISCARDED_ASIDE_PREFIX = '.discarded-';
// The holding path a revert's three-way swap parks the outgoing live tree in. Recoverable: if the
// process dies mid-swap, recoverInterruptedReverts puts it back. See revertApplication.
const REVERTING_PREFIX = '.reverting-';
// Records the manifest state a revert recovery is working toward. Written before recovery mutates
// anything and removed only once the directory, manifest and config are all durable, so a recovery
// interrupted part-way is resumable rather than losing its own evidence. See recoverInterruptedReverts.
const REVERT_RECOVERY_SUFFIX = '.recovering.json';
// Distinguishes the no-live restore branch's marker from a swap's holding-bound one; there is no
// holding directory in that branch, so the marker needs its own stable name.
const RESTORE_MARKER_INFIX = '.restoring';

// The revert-intent marker is named after the holding directory it describes. A fixed per-component
// path would be reused by every future revert of that component, so an orphan left by one attempt
// could be trusted by a later unrelated one.
function revertRecoveryMarkerFor(holdingPath: string): string {
	return `${holdingPath}${REVERT_RECOVERY_SUFFIX}`;
}
// Splits `<componentName>-<uuid>` off a revert holding directory name, anchored on the UUID so a
// component name containing dashes is preserved intact.
const REVERTING_NAME_PATTERN = /^(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETIRED_ASIDE_PREFIX = '.retired-';
const PRIOR_ABSENT_RECORD_SUFFIX = '-prior-absent';
const DEFAULT_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
const COMPONENT_PREPARATION_WAIT_MARGIN_MS = 30000;
const COMPONENT_RECOVERY_WAIT_TIMEOUT_MS = 30000;
const COMPONENT_RECOVERY_TRY_TIMEOUT_MS = 250;
const COMPONENT_RECOVERY_LOCK_PURPOSE = 'component-recovery';
const MAX_GIT_EXTRACTION_COMMANDS = 4;
const MAX_INSTALL_COMMANDS = 2;

// Hidden directory under the components root where the INCOMING version of a component is
// fully built (extracted + `npm install`) before it goes live — the counterpart to
// ASIDE_STAGING_DIR, which holds the OUTGOING version. Two-phase deploy stages here first
// (the stage phase), then activateStagedApplication renames the staged copy into the live
// component path in one atomic step (the activate phase).
//
// It lives UNDER the components root on purpose, even though the bytes are "temporary":
//   - Same filesystem as the live path, so the go-live rename() is atomic. An os.tmpdir()
//     location is frequently a different mount (tmpfs / separate volume); a cross-device
//     rename throws EXDEV and degrades to a slow recursive copy — reintroducing the very
//     downtime window the two-phase split exists to remove.
//   - The leading dot keeps loadComponentDirectories (componentLoader) from loading it as a
//     phantom component, and it is not the watched base of any component's file watcher
//     (those are rooted at each live component dir), so building here triggers no
//     restart-on-change storm and needs no deploy:start watcher suppression.
export const DEPLOY_STAGING_DIR = '.deploy-staging';
export const DEPLOY_ACTIVATION_DIR = '.deploy-activating';
const STAGED_COMPLETE_MARKER = '.complete';
const ACTIVATION_BACKUP_PREFIX = '.previous-';
const ACTIVATION_NEW_PREFIX = '.new-';
const DEPLOYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Hidden directory under the components root that RETAINS the immediately-previous live version of a
// component (`.deploy-previous/<name>`) after an activate swap, so it can be swapped back by
// revert_component. Exactly one previous version is kept per component — each activate evicts the
// older one — so the retention cost is bounded at one extra copy. Same filesystem as the live path
// (atomic swap on revert), leading-dot-hidden (loader/watchers ignore it). This is what turns the
// deploy swap into something reversible: a customer can activate, run their own health checks, and
// revert if unhappy; and a partially-failed activate can be swapped back cluster-wide.
export const DEPLOY_PREVIOUS_DIR = '.deploy-previous';

// Max not-yet-activated staged builds kept per component before the oldest are evicted on the next
// stage. A full deploy consumes its staged build immediately (activate renames it live), so this only
// bounds `activate: false` stage-and-stops that are never activated. Configurable via
// deployment_stagingRetention_maxCount.
export const DEFAULT_STAGING_RETENTION_MAX_COUNT = 5;

export function getStagingRetentionMaxCount(): number {
	const configured = getConfigValue(CONFIG_PARAMS.DEPLOYMENT_STAGINGRETENTION_MAXCOUNT);
	// Only a number or numeric string is a valid count; reject everything else (unset, boolean, array,
	// blank) and fall back to the default — mirroring getPayloadRetentionMaxSize's defensive coercion.
	if (typeof configured !== 'number' && typeof configured !== 'string') return DEFAULT_STAGING_RETENTION_MAX_COUNT;
	if (typeof configured === 'string' && configured.trim() === '') return DEFAULT_STAGING_RETENTION_MAX_COUNT;
	const parsed = Number(configured);
	return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_STAGING_RETENTION_MAX_COUNT;
}

/**
 * Prune the oldest not-yet-activated staged builds for a component, keeping at most `maxCount` (newest
 * by mtime) and ALWAYS retaining the just-built one (`keepStagingId`). Staged builds live at
 * `.deploy-staging/<stagingId>/<name>`, and each stagingId parent holds exactly one component's build,
 * so an evicted build's whole parent directory is removed. Entirely best-effort: any error (a racing
 * concurrent stage, a busy dir) is logged at trace and never fails the stage that triggered it.
 */
async function pruneStagedBuilds(componentName: string, keepStagingId: string, maxCount: number): Promise<void> {
	try {
		if (!(maxCount >= 1)) return;
		const componentsRoot = getConfigPath(CONFIG_PARAMS.COMPONENTSROOT);
		if (!componentsRoot) return;
		const stagingRoot = join(componentsRoot, DEPLOY_STAGING_DIR);
		let parents: import('node:fs').Dirent[];
		try {
			parents = await readdir(stagingRoot, { withFileTypes: true });
		} catch (err) {
			if ((err as any).code === 'ENOENT') return; // nothing staged yet
			throw err;
		}
		// Collect this component's staged builds: <stagingRoot>/<stagingId>/<name> that still exist.
		const builds: Array<{ stagingId: string; parentPath: string; mtime: number }> = [];
		for (const parent of parents) {
			if (!parent.isDirectory()) continue;
			const parentPath = join(stagingRoot, parent.name);
			try {
				const st = await stat(join(parentPath, componentName));
				builds.push({ stagingId: parent.name, parentPath, mtime: st.mtimeMs });
			} catch (err) {
				if ((err as any).code !== 'ENOENT') throw err; // parent holds a different component; skip
			}
		}
		// Always keep the build we just made, plus the newest (maxCount - 1) of the OTHERS by mtime; evict
		// the rest. Computing it as "keep keepStagingId + top-(N-1) others" (rather than "evict everything
		// past the top N") keeps the count exact even when mtimes tie and the just-built one would
		// otherwise sort into the eviction window. Await the evictions (best-effort via allSettled) so the
		// retention count is settled by the time the stage returns.
		const others = builds.filter((build) => build.stagingId !== keepStagingId).sort((a, b) => b.mtime - a.mtime);
		const evictions = others
			.slice(Math.max(0, maxCount - 1))
			.map((build) =>
				rm(build.parentPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((err) =>
					logger.trace?.(`Deferred prune of staged ${componentName} build ${build.stagingId}: ${err.message}`)
				)
			);
		await Promise.allSettled(evictions);
	} catch (err) {
		logger.trace?.(`Staged-build prune for ${componentName} skipped: ${(err as Error).message}`);
	}
}

/**
 * Park `targetDirPath` in this component's `.deploy-aside` directory under a name that marks it
 * KNOWN-DISPOSABLE at the moment it is parked, and sweep it best-effort. Returns false when there
 * was nothing there to park.
 *
 * Renaming aside — instead of clearing in place — is immune to the race where a still-running worker
 * keeps writing into the directory (e.g. a live Next.js app writing into `.next/cache`): an in-place
 * recursive rm races that writer and fails with ENOTEMPTY, whereas the rename is atomic and the old
 * worker harmlessly keeps writing into the renamed inode until it exits on restart.
 *
 * The `.discarded-` prefix is load-bearing, and is the whole reason this exists alongside the
 * extraction transaction's `.in-progress-` asides. `.deploy-aside` has exactly ONE contract
 * (harper#1849 review, @kriszyp): an `.in-progress-` directory with no matching `.retired-` marker is
 * a ROLLBACK RECORD, and `recoverInterruptedComponentExtractions` restores the newest such directory
 * OVER the live component path at startup. A tree that is already known to be garbage when it is
 * parked — the evicted two-deploys-ago retained-previous below — must therefore never carry that
 * prefix, or a crash between parking and sweeping would make startup recovery resurrect an ancient
 * version over the current one. `.discarded-` says "never restore this", and cleanupExtractionPaths
 * already removes anything that is not an unretired `.in-progress-`.
 */
export async function discardDirAside(targetDirPath: string, componentName: string): Promise<boolean> {
	const asideStagingDir = extractionStagingDirectory(targetDirPath);
	try {
		// lstat, not access(F_OK): access follows symlinks, so a DANGLING symlink at the path (left by a
		// prior `file:`-directory deploy whose target was removed) would report ENOENT and be skipped
		// here — then a later mkdir fails EEXIST because the dead link still occupies the path. lstat
		// sees the link itself, so we park it like any other occupant.
		await lstat(targetDirPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; // nothing there to park
		throw err;
	}
	await ensureExtractionStagingDirectory(asideStagingDir);
	const discardedPath = join(asideStagingDir, `${DISCARDED_ASIDE_PREFIX}${Date.now()}-${process.pid}-${randomUUID()}`);
	await rename(targetDirPath, discardedPath);
	// Best-effort: the outgoing worker may still hold files open in the renamed copy, so a failure here
	// is expected in that case and swept by the next deploy or the next startup recovery pass.
	void cleanupExtractionPaths(
		{ name: componentName, dirPath: targetDirPath, logger },
		asideStagingDir,
		new Set([discardedPath])
	).catch((err) => logger.trace?.(`Deferred cleanup of discarded ${componentName} directory: ${errorMessage(err)}`));
	return true;
}

/**
 * The retained-previous manifest for a component: which deployment produced the tree now sitting in
 * `.deploy-previous/<name>`, which produced the tree now LIVE, and the root-config entry each one was
 * activated with.
 *
 * This is what makes `revert_component` addressable rather than a blind toggle (harper#1849 review,
 * @kriszyp): the caller names the deployment it expects to end up live, so a retried request whose
 * response was lost is a no-op instead of flipping the rejected release back in. It is also what lets
 * a revert restore persistent state, not just the directory: `application_config` is the root-config
 * entry (and install-lock entry) that belongs with each tree, so reverting away from a `package`
 * deploy removes that package reference instead of leaving `installApplications()` free to reinstall
 * the reverted-away version over the restored directory on the next cold start.
 *
 * `application_config: null` means "that version had no root-config entry" (a payload deploy) and is
 * therefore an instruction to DELETE the entry on revert, not to leave it alone.
 */
type RetainedVersion = {
	deployment_id: string | null;
	application_config: ApplicationConfig | null;
};

type RetainedPreviousManifest = {
	previous: RetainedVersion;
	live: RetainedVersion;
};

// Absolute path of the retained-previous copy for a component's live directory, and of the sidecar
// manifest describing it. The manifest is a sibling FILE rather than something inside the retained
// tree, so the tree stays a byte-for-byte copy of what was live.
function previousDirPathFor(liveDirPath: string): string {
	return join(dirname(liveDirPath), DEPLOY_PREVIOUS_DIR, basename(liveDirPath));
}

function previousManifestPathFor(liveDirPath: string): string {
	return `${previousDirPathFor(liveDirPath)}.json`;
}

async function readRetainedPreviousManifest(liveDirPath: string): Promise<RetainedPreviousManifest | undefined> {
	try {
		const parsed = JSON.parse(await readFile(previousManifestPathFor(liveDirPath), 'utf8'));
		if (!parsed?.previous || !parsed?.live) return undefined;
		return parsed as RetainedPreviousManifest;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw err;
	}
}

async function readRevertRecoveryMarker(markerPath: string): Promise<RetainedPreviousManifest | undefined> {
	try {
		const parsed = JSON.parse(await readFile(markerPath, 'utf8'));
		if (!parsed?.previous || !parsed?.live) return undefined;
		return parsed as RetainedPreviousManifest;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

async function writeJsonAtomically(targetPath: string, value: unknown): Promise<void> {
	const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
	await mkdir(dirname(targetPath), { recursive: true });
	await writeFile(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
	await rename(tempPath, targetPath);
}

async function writeRetainedPreviousManifest(liveDirPath: string, manifest: RetainedPreviousManifest): Promise<void> {
	const manifestPath = previousManifestPathFor(liveDirPath);
	// Temp + rename so a crash mid-write can never leave a half-written manifest, which would make a
	// retained tree unaddressable (and so unrevertable).
	const tempPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
	await mkdir(dirname(manifestPath), { recursive: true });
	await writeFile(tempPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
	await rename(tempPath, manifestPath);
}

/**
 * Retain the tree this activation displaced as the component's rollback source
 * (`.deploy-previous/<name>`), recording which deployment produced it and the root-config entry it
 * was activated with. Called by activateStagedApplication after a committed swap, in place of simply
 * deleting the displaced tree.
 *
 * Exactly one previous version is kept per component — this evicts the older one — so retention costs
 * a bounded one extra copy per component rather than growing without limit.
 *
 * Best-effort by design: a component that cannot retain its previous version is still successfully
 * deployed, it just isn't revertable. Failing the deploy here would be strictly worse.
 */
async function retainActivatedPrevious(
	application: Application,
	displacedPath: string | undefined,
	deploymentId: string,
	activatedConfig: ApplicationConfig | undefined,
	outgoing: RetainedVersion
): Promise<void> {
	const liveDirPath = application.dirPath;
	const previousPath = previousDirPathFor(liveDirPath);
	try {
		// The manifest goes FIRST, by being removed. getRevertTarget only checks that a retained tree
		// exists, so a manifest that outlives its tree is worse than no manifest: it names a deployment id
		// against bytes that are no longer the ones it describes, and an addressed revert would then either
		// restore the wrong tree or report "already live" and do nothing. Clearing it means every
		// intermediate state below reads as "not revertable", which is what the failure path promises.
		await rm(previousManifestPathFor(liveDirPath), { force: true });
		// Evict the older retained-previous (two deploys ago) before renaming this one into its place, so
		// the rename never races an incomplete recursive delete (ENOTEMPTY). Also covers the first-deploy
		// case, where any retained tree left over from a dropped-and-redeployed component is stale.
		await discardDirAside(previousPath, application.name);
		if (displacedPath) {
			await mkdir(dirname(previousPath), { recursive: true });
			await rename(displacedPath, previousPath);
		}
		// Written unconditionally: even a first-ever deploy that retained nothing has to record which
		// deployment is now live, or the NEXT activation cannot name the tree it displaces and the
		// component stays unrevertable forever.
		await writeRetainedPreviousManifest(liveDirPath, {
			previous: displacedPath ? outgoing : { deployment_id: null, application_config: null },
			live: { deployment_id: deploymentId, application_config: activatedConfig ?? null },
		});
	} catch (err) {
		// Best-effort by design: the deploy succeeded, so failing it here would be worse. Drop the manifest
		// so the component reads as not revertable rather than revertable-to-the-wrong-bytes.
		await rm(previousManifestPathFor(liveDirPath), { force: true }).catch(() => {});
		logger.warn(
			`Deployed ${application.name}, but could not retain its previous version for revert:`,
			errorForLog(err as Error)
		);
	}
}

/**
 * Repair a revert that died between renames. The holding directory (`.reverting-<name>-<uuid>`, a
 * sibling of the retained previous) only exists while a swap is in flight, so finding one at startup
 * means the process was killed mid-swap and the component may have no live directory at all.
 *
 * Recovery restores the holding tree to whichever slot is empty: the live path when the swap had not
 * yet placed the reverted-to version (so the component comes back on the version it was serving), or
 * the retained-previous path when the swap DID complete and only the retain step was lost. If both
 * slots are occupied the swap finished and the holding tree is residue, so it is discarded.
 *
 * Best-effort per component: one component's unrecoverable state must not stop the rest from loading.
 */
export async function recoverInterruptedReverts(componentsRootDirPath: string): Promise<Map<string, Error>> {
	const previousRoot = join(componentsRootDirPath, DEPLOY_PREVIOUS_DIR);
	const failures = new Map<string, Error>();
	let entries;
	try {
		entries = await readdir(previousRoot, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failures;
		throw error;
	}
	// A crash between the final rename and the marker removal leaves a marker whose holding directory is
	// gone. Nothing would revisit it — the loop below is keyed on finding a holding directory — so sweep
	// those first rather than leave them to be trusted by a future attempt.
	const entryNames = new Set(entries.map((entry) => entry.name));
	for (const entry of entries) {
		if (entry.isDirectory() || !entry.name.endsWith(REVERT_RECOVERY_SUFFIX)) continue;
		const holdingName = entry.name.slice(0, -REVERT_RECOVERY_SUFFIX.length);
		if (!entryNames.has(holdingName)) await rm(join(previousRoot, entry.name), { force: true }).catch(() => {});
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(REVERTING_PREFIX)) continue;
		const holding = join(previousRoot, entry.name);
		// `.reverting-<componentName>-<uuid>`. The component name may itself contain dashes, so match the
		// trailing UUID explicitly rather than cutting at the last dash — which would leave most of the
		// UUID glued to the name and recover into the wrong (or a nonexistent) component directory.
		const componentName = REVERTING_NAME_PATTERN.exec(entry.name.slice(REVERTING_PREFIX.length))?.[1];
		if (!componentName || !safeComponentName(componentName)) {
			await rm(holding, { recursive: true, force: true }).catch(() => {});
			continue;
		}
		const liveDirPath = join(componentsRootDirPath, componentName);
		try {
			await withComponentPreparationLock(liveDirPath, async () => {
				const liveExists = await lstat(liveDirPath).then(
					() => true,
					(err) => {
						if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
						throw err;
					}
				);
				if (!liveExists) {
					// Two different crash shapes land here, and they need opposite repairs. Either the swap never
					// placed the reverted-to version (undo: the holding tree goes back to live), or it did and
					// compensation got as far as moving live away before failing (roll forward: the reverted-to
					// tree in `previous` goes to live, because config and the manifest already describe it).
					// The marker distinguishes them: if the on-disk manifest already matches its intended `live`,
					// the persistent side committed and undoing the directories would contradict it.
					const marker = await readRevertRecoveryMarker(revertRecoveryMarkerFor(holding));
					const manifest = await readRetainedPreviousManifest(liveDirPath);
					const persistedAlreadyExchanged =
						!!marker &&
						!!manifest &&
						manifest.live?.deployment_id === marker.live?.deployment_id &&
						manifest.previous?.deployment_id === marker.previous?.deployment_id;
					const previousStat = await lstat(previousDirPathFor(liveDirPath)).catch(() => undefined);
					if (persistedAlreadyExchanged && previousStat?.isDirectory()) {
						await mkdir(dirname(liveDirPath), { recursive: true });
						await rename(previousDirPathFor(liveDirPath), liveDirPath);
						await rename(holding, previousDirPathFor(liveDirPath));
						await rm(revertRecoveryMarkerFor(holding), { force: true });
						logger.warn(
							`Completed an interrupted ${componentName} revert whose compensation had already begun; ` +
								`the reverted-to version is live and matches its persisted configuration`
						);
						return;
					}
					await mkdir(dirname(liveDirPath), { recursive: true });
					await rename(holding, liveDirPath);
					await rm(revertRecoveryMarkerFor(holding), { force: true });
					logger.warn(
						`Restored the live ${componentName} component directory after an interrupted revert; ` +
							`the revert did not take effect and can be retried`
					);
					return;
				}
				const previousPath = previousDirPathFor(liveDirPath);
				const previousExists = await lstat(previousPath).then(
					() => true,
					(err) => {
						if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
						throw err;
					}
				);
				if (!previousExists) {
					// The reverted-to version is live and only the retain step was lost, so finish it. The
					// marker is the source of truth over the manifest, because an earlier pass may already have
					// exchanged the manifest and exchanging it twice flips it back.
					const recoveryMarkerPath = revertRecoveryMarkerFor(holding);
					let intended = await readRevertRecoveryMarker(recoveryMarkerPath);
					if (!intended) {
						const staleManifest = await readRetainedPreviousManifest(liveDirPath);
						if (staleManifest) {
							intended = { previous: staleManifest.live, live: staleManifest.previous };
							await writeJsonAtomically(recoveryMarkerPath, intended);
						}
					}
					if (intended) {
						// Config first, then manifest, then the directory — so the holding tree survives until
						// everything else is durable. Each step is idempotent on a repeat pass.
						const configTransaction = await createApplicationConfigTransaction(
							componentName,
							intended.live.application_config
						);
						await configTransaction.commit();
						await writeRetainedPreviousManifest(liveDirPath, intended);
					}
					await mkdir(dirname(previousPath), { recursive: true });
					await rename(holding, previousPath);
					await rm(recoveryMarkerPath, { force: true });
					logger.warn(
						`Completed an interrupted ${componentName} revert: the reverted-to version is live, the ` +
							`version it displaced is retained again, and its configuration has been reconciled`
					);
					return;
				}
				// Both slots occupied: the swap completed, so this is residue.
				await rm(holding, { recursive: true, force: true });
			});
		} catch (error) {
			const recoveryError = error instanceof Error ? error : new Error(String(error));
			failures.set(componentName, recoveryError);
			logger.error(`Could not recover the interrupted ${componentName} revert:`, errorForLog(recoveryError));
		}
	}
	return failures;
}

/**
 * Remove a component's retained previous version and its manifest. Both live under the components root
 * rather than inside the component directory, so dropping the component does not reach them — and a
 * surviving retained tree lets `revert_component` resurrect a dropped component, re-adding its
 * root-config and application-lock entries.
 */
export async function discardRetainedPrevious(componentDirPath: string): Promise<void> {
	await rm(previousManifestPathFor(componentDirPath), { force: true });
	await discardDirAside(previousDirPathFor(componentDirPath), basename(componentDirPath));
	const previousRoot = join(dirname(componentDirPath), DEPLOY_PREVIOUS_DIR);
	for (const entry of await readdir(previousRoot, { withFileTypes: true }).catch(() => [])) {
		// Any in-flight revert artifact for this component is meaningless once it is dropped.
		if (entry.name.startsWith(`${REVERTING_PREFIX}${basename(componentDirPath)}-`)) {
			await rm(join(previousRoot, entry.name), { recursive: true, force: true }).catch(() => {});
		}
	}
	await rmdir(previousRoot).catch(() => {});
}

/** What a component can currently be reverted to, for reporting and for revert targeting. */
export async function getRevertTarget(
	componentDirPath: string
): Promise<{ live: RetainedVersion; previous: RetainedVersion } | undefined> {
	const manifest = await readRetainedPreviousManifest(componentDirPath);
	if (!manifest) return undefined;
	try {
		await lstat(previousDirPathFor(componentDirPath));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; // manifest without a tree
		throw err;
	}
	return { live: manifest.live, previous: manifest.previous };
}

/**
 * Swap a component's live version with its retained previous version (`.deploy-previous/<name>`),
 * atomically, then let watchers restart onto it. This is what backs `revert_component`: a customer can
 * deploy, run their own health checks, and swap back fast — with no package resolution, artifact
 * download or install, because the bytes are already on disk.
 *
 * ADDRESSED, NOT TOGGLED (harper#1849 review, @kriszyp). The caller passes the deployment id it
 * expects to be live when this returns:
 *   - already live → a no-op success, so an ordinary request retry whose first response was lost
 *     cannot swap the rejected release back in.
 *   - matches the retained previous → swap, and the displaced tree becomes the new retained previous
 *     (so a deliberate, explicitly-targeted revert-of-a-revert still rolls forward).
 *   - anything else → rejected, naming what this component can actually be reverted to.
 *
 * Returns the root-config entry the newly-live tree was originally activated with, so the caller can
 * restore persistent config/install-lock state as part of the rollback, plus whether a swap happened.
 *
 * This method should only be called from the main thread.
 */
export async function revertApplication(
	application: Application,
	toDeploymentId: string,
	hooks: {
		commitPersistentState?: (config: ApplicationConfig | null) => Promise<void>;
		rollbackPersistentState?: () => Promise<void>;
	} = {}
): Promise<{ swapped: boolean; activatedConfig: ApplicationConfig | null; fromDeploymentId: string | null }> {
	const liveDirPath = application.dirPath;
	return withComponentPreparationLock(liveDirPath, async () => {
		const target = await getRevertTarget(liveDirPath);
		if (!target) {
			throw new Error(
				`Cannot revert ${application.name}: no previous version is retained. A component must have been ` +
					`deployed over a prior version (which activation retains as .deploy-previous) to be reverted.`
			);
		}
		if (target.live.deployment_id === toDeploymentId) {
			// Already there. Idempotent so a retry is safe.
			return { swapped: false, activatedConfig: target.live.application_config, fromDeploymentId: null };
		}
		if (target.previous.deployment_id !== toDeploymentId) {
			throw new Error(
				`Cannot revert ${application.name} to deployment '${toDeploymentId}': it is neither the live version ` +
					`('${target.live.deployment_id ?? 'unknown'}') nor the retained previous version ` +
					`('${target.previous.deployment_id ?? 'unknown'}'). Only the immediately-previous version is retained ` +
					`on disk; redeploy the version you want with deploy_component instead.`
			);
		}

		const previousPath = previousDirPathFor(liveDirPath);
		const deployLifecycleId = await broadcastDeployStart(application.name);
		try {
			let liveExists = true;
			try {
				await lstat(liveDirPath);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') liveExists = false;
				else throw err;
			}
			await mkdir(dirname(previousPath), { recursive: true });
			if (liveExists) {
				// Three-way atomic swap through a hidden holding path: live → holding, previous → live,
				// holding(old live) → previous. The only window where `dirPath` is absent is between the
				// first two renames, and deploy:start suppresses watchers across it (same as activation).
				//
				// Each step is compensated, because a failure here is the one that hurts most: after the
				// first rename the component has NO live directory, so an uncompensated I/O error (disk
				// full, a permission change, an unexpected fault on previousPath) would leave the component
				// unservable with its bytes stranded under the holding path. The holding name is also
				// recoverable by name at startup (recoverInterruptedReverts), which covers the case
				// compensation cannot: the process dying between renames.
				const holding = join(dirname(previousPath), `${REVERTING_PREFIX}${basename(liveDirPath)}-${randomUUID()}`);
				// Written before anything moves: a crash between the renames and the durable writes below
				// leaves the holding tree AND this marker, which is what lets recoverInterruptedReverts finish
				// the job. Without it, recovery would re-exchange an already-exchanged manifest.
				const recoveryMarkerPath = revertRecoveryMarkerFor(holding);
				await writeJsonAtomically(recoveryMarkerPath, {
					previous: target.live,
					live: target.previous,
				});
				await rename(liveDirPath, holding);
				try {
					await rename(previousPath, liveDirPath);
				} catch (swapError) {
					// Nothing is live: put the outgoing tree straight back and fail with the component intact.
					await rename(holding, liveDirPath).catch((restoreError) => {
						throw new AggregateError(
							[swapError, restoreError],
							`Failed to revert ${application.name} and could not restore its live directory from ` +
								`${holding}; the component has no live version until that directory is restored`
						);
					});
					throw swapError;
				}
				// Persistent state commits here, inside the lock and while the holding tree still exists.
				// Committing it after the lock released let a queued activation swap and commit in between,
				// leaving that activation's bytes live under this revert's config.
				//
				// Everything from the commit to the final rename shares one undo path. A failure after the
				// commit — a manifest write, or the retain rename — has to take config and the application
				// lock back too, or the directories end up describing one release while the persisted state
				// names the other, and a cold start reinstalls over the live bytes.
				let persistCommitted = false;
				let manifestWritten = false;
				const undoRevert = async (cause: unknown, detail: string): Promise<never> => {
					const undoErrors: unknown[] = [];
					if (persistCommitted) {
						await hooks.rollbackPersistentState?.().catch((rollbackError) => undoErrors.push(rollbackError));
					}
					if (manifestWritten) {
						// The manifest currently claims the exchange happened. Put it back before the directories
						// move, so no window reports the reverted-to version as live over the old bytes.
						await writeRetainedPreviousManifest(liveDirPath, {
							previous: target.previous,
							live: target.live,
						}).catch((manifestError) => undoErrors.push(manifestError));
					}
					try {
						await rename(liveDirPath, previousPath);
						await rename(holding, liveDirPath);
						application.useLiveBuildDir();
						await rm(recoveryMarkerPath, { force: true });
					} catch (restoreError) {
						undoErrors.push(restoreError);
					}
					if (undoErrors.length) {
						throw new AggregateError(
							[cause, ...undoErrors],
							`Reverted ${application.name} but could not ${detail}, and could not fully undo it; ` +
								`${holding} may still hold the previously-live tree`
						);
					}
					throw cause;
				};
				try {
					await hooks.commitPersistentState?.(target.previous.application_config);
					persistCommitted = true;
					application.useLiveBuildDir();
					await writeRetainedPreviousManifest(liveDirPath, {
						previous: target.live,
						live: target.previous,
					});
					manifestWritten = true;
				} catch (persistError) {
					await undoRevert(persistError, 'persist its configuration');
				}
				// Consumes the recovery evidence, so it goes last.
				try {
					await rename(holding, previousPath);
				} catch (retainError) {
					await undoRevert(retainError, 'retain the displaced version');
				}
				await rm(recoveryMarkerPath, { force: true });
			} else {
				// No live version to preserve; restore the previous into place. Nothing becomes the new
				// retained previous, so the component can't be reverted again until its next deploy.
				//
				// This branch gets the same intent marker and undo as the swap above: without them a config
				// failure after the rename left the retained slot empty, the persisted state naming an absent
				// version, and no `.reverting-*` artifact for recovery to find.
				const restoreMarkerPath = revertRecoveryMarkerFor(`${previousPath}${RESTORE_MARKER_INFIX}`);
				await writeJsonAtomically(restoreMarkerPath, {
					previous: { deployment_id: null, application_config: null },
					live: target.previous,
				});
				await rename(previousPath, liveDirPath);
				try {
					await hooks.commitPersistentState?.(target.previous.application_config);
					application.useLiveBuildDir();
					await writeRetainedPreviousManifest(liveDirPath, {
						previous: { deployment_id: null, application_config: null },
						live: target.previous,
					});
				} catch (persistError) {
					const undoErrors: unknown[] = [];
					await hooks.rollbackPersistentState?.().catch((rollbackError) => undoErrors.push(rollbackError));
					await rename(liveDirPath, previousPath).catch((restoreError) => undoErrors.push(restoreError));
					await rm(restoreMarkerPath, { force: true }).catch(() => {});
					if (undoErrors.length) {
						throw new AggregateError(
							[persistError, ...undoErrors],
							`Restored ${application.name} from its retained version but could not persist configuration ` +
								`or undo the restore`
						);
					}
					throw persistError;
				}
				await rm(restoreMarkerPath, { force: true });
			}
			return {
				swapped: true,
				activatedConfig: target.previous.application_config,
				fromDeploymentId: target.live.deployment_id,
			};
		} finally {
			broadcastDeployEnd(application.name, deployLifecycleId);
		}
	});
}
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
 * Writes the application into `application.buildDirPath`, overwriting any existing directory there.
 * By default that is the live component directory (`application.dirPath`); during a two-phase deploy
 * `stageApplication` points it at the hidden staging directory instead, so the live path is never
 * touched until `activateStagedApplication` swaps the staged copy into place.
 *
 * This method may be called from any Harper thread. Same-component calls are serialized across
 * threads by the preparation lock below.
 */
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
		// Given a package, there are a a couple options. The tarball is packed next to the build
		// target (the staging dir during a two-phase deploy) so it lands on the same filesystem and
		// is swept with the staging area rather than littering the live components root.
		const parentDirPath = dirname(application.buildDirPath);

		// If the package identifier is a file path we need to check if its a tarball or a directory
		if (application.packageIdentifier.startsWith('file:')) {
			const packagePath = application.packageIdentifier.slice(5);
			try {
				// Have to remove the 'file:' prefix in order to use fs methods
				const stats = await stat(packagePath);

				if (stats.isDirectory()) {
					// If its a directory, symlink. Anything already at the build target has to go first, or
					// symlink() throws EEXIST — which on the in-place path means a redeploy of a
					// directory-package component.
					//
					// Parked aside with an atomic rename, NOT removed in place. This returns early, before
					// the extraction transaction below, so an in-place recursive rm here would delete the
					// LIVE component tree outright: no aside, no rollback record, nothing for startup
					// recovery to restore, and it races a still-running worker writing into the directory it
					// is deleting (the ENOTEMPTY/EPERM hazard documented on discardDirAside). The rename is
					// atomic and the sweep is best-effort afterwards.
					await discardDirAside(application.buildDirPath, application.name);
					await mkdir(dirname(application.buildDirPath), { recursive: true });
					await symlink(packagePath, application.buildDirPath, 'dir');
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
	// The directory this extraction replaces. Defaults to the live component path — so the one-shot
	// deploy, boot-time installs, and every direct extractApplication caller behave exactly as before —
	// but points at `.deploy-staging/<stagingId>/<name>` while a two-phase stage is building. Everything
	// below is expressed against this target rather than `application.dirPath`, which is what lets ONE
	// transaction protocol cover both an in-place replacement and a staged build.
	const buildDirPath = application.buildDirPath;
	const buildingInPlace = buildDirPath === application.dirPath;
	// What the rollback/cleanup helpers act on: `dirPath` here is the extraction TARGET, which is not
	// necessarily the live component path.
	const extractionContext: ExtractionContext = {
		name: application.name,
		dirPath: buildDirPath,
		logger: application.logger,
	};
	const asideStagingDir = extractionStagingDirectory(buildDirPath);
	const transactionPaths = new Set<string>();
	let asidePath: string | undefined;
	let recoveryRecordPath: string;
	try {
		await ensureExtractionStagingDirectory(asideStagingDir);
		await recoverOrCleanupStaleExtractionPaths(extractionContext, asideStagingDir);
		let componentExists = true;
		try {
			// lstat, not access: access follows symlinks, so a dangling symlink at the target reports ENOENT
			// and the mkdir below then fails EEXIST because the dead link still occupies the path.
			await lstat(buildDirPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			componentExists = false;
		}
		if (componentExists) {
			await ensureExtractionStagingDirectory(asideStagingDir);
			asidePath = join(asideStagingDir, `${IN_PROGRESS_ASIDE_PREFIX}${Date.now()}-${process.pid}-${randomUUID()}`);
			await rename(buildDirPath, asidePath);
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
		// A non-null aside means something already occupied the extraction target, so an IN-PLACE build
		// is replacing an already-active component rather than deploying a new one (harper#1806). Only
		// meaningful when the target IS the live directory: during a two-phase stage the target is a
		// fresh staging dir whose prior existence says nothing about the live component, so
		// isNewComponent is left for activateStagedApplication to read off the live path at swap time.
		if (asidePath && buildingInPlace) application.isNewComponent = false;

		try {
			await mkdir(buildDirPath, { recursive: true });
			await pipeline(tarball, gunzip(), extract(buildDirPath));

			const extracted = await readdir(buildDirPath, { withFileTypes: true });
			if (extracted.length === 1 && extracted[0].isDirectory()) {
				const topLevelDirPath = join(buildDirPath, extracted[0].name);
				if (process.platform === 'win32') {
					for (const childName of await readdir(topLevelDirPath)) {
						await rename(join(topLevelDirPath, childName), join(buildDirPath, childName));
					}
					await rmdir(topLevelDirPath);
				} else {
					await ensureExtractionStagingDirectory(asideStagingDir);
					const tempDirPath = join(asideStagingDir, `.normalize-${process.pid}-${Date.now()}-${randomUUID()}`);
					transactionPaths.add(tempDirPath);
					await rename(topLevelDirPath, tempDirPath);
					await rmdir(buildDirPath);
					await rename(tempDirPath, buildDirPath);
					transactionPaths.delete(tempDirPath);
				}
			}
		} catch (error) {
			try {
				await rollbackExtractedDirectory(extractionContext, asideStagingDir, asidePath, transactionPaths, false);
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
			await cleanupExtractionPaths(extractionContext, asideStagingDir, transactionPaths);
		},
		async rollback() {
			if (settled) return;
			await rollbackExtractedDirectory(extractionContext, asideStagingDir, asidePath, transactionPaths, true);
			settled = true;
		},
	};
	if (deferCommit) return transaction;
	await transaction.commit();
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

async function ensureExtractionStagingDirectory(asideStagingDir: string): Promise<void> {
	for (const stagingDir of [dirname(asideStagingDir), asideStagingDir]) {
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
 * Install an application into `application.buildDirPath` using either a
 * configured `application.install` command, a derived package manager from the
 * application's `package.json#devEngines`, or falling back to the default
 * package manager, `npm`.
 *
 * `buildDirPath` is the live component directory by default, or the hidden staging directory
 * during a two-phase deploy (see stageApplication) — so `npm install`, the slowest and most
 * failure-prone step, runs against the staged copy and never leaves the live path half-installed.
 *
 * Will return early if `node_modules` already exists within the build directory.
 *
 * This method may be called from any Harper thread as part of a serialized preparation.
 */
export async function installApplication(application: Application) {
	const buildDirPath = application.buildDirPath;
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
		// buildDirPath, not dirPath: during a two-phase stage the candidate being installed is the staging
		// tree, and the live directory's node_modules says nothing about it.
		await access(join(buildDirPath, 'node_modules'), constants.F_OK);
		application.logger.info(
			`Application ${application.name} already has node_modules; skipping install and treating the runtime as opaque for redeploy comparison`
		);
		// The installed tree came from the payload rather than from an install we ran, so its contents
		// can't be compared against a fresh install to decide whether the runtime changed.
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
	// Stable identifier for the hidden staging directory this deploy builds into, so a two-phase
	// deploy's activate phase can reconstruct the same staging path the prior stage phase
	// built (both derive it from the deployment id). Defaults to a random UUID for
	// callers that stage and activate against one in-memory Application instance.
	stagingId?: string;
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
	// Stable id for this deploy's staging directory (see ApplicationOptions.stagingId).
	stagingId: string;
	// When set, extract/install build here instead of the live `dirPath`. stageApplication() points
	// it at `stagingDirPath`; activateStagedApplication() clears it after swapping the staged copy live.
	#buildDirPath?: string;
	#npmrcTempDir?: string;
	#gitCredentialSession?: GitCredentialSession;
	// Existing components rely on their runtime-equivalence checks; only a first deploy restarts unconditionally.
	isNewComponent: boolean = true;
	packageMetadataChanged: boolean = false;
	installationIsOpaque: boolean = false;

	constructor({
		name,
		payload,
		packageIdentifier,
		install,
		onInstallLine,
		credentials,
		stagingId,
	}: ApplicationOptions) {
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
		this.stagingId = stagingId ?? randomUUID();
		this.logger = logger.loggerWithTag(name);
		this.packageManagerPrefix = getConfigValue(CONFIG_PARAMS.APPLICATIONS_PACKAGEMANAGERPREFIX);
	}

	// Directory where extract/install currently build. Defaults to the live component directory
	// (`dirPath`) — the legacy in-place path, still used by boot-time installApplications() — and is
	// repointed at the hidden staging directory for the duration of a two-phase deploy.
	get buildDirPath(): string {
		return this.#buildDirPath ?? this.dirPath;
	}

	// Hidden, per-deploy staging directory the incoming version is built into before it goes live:
	// `<componentsRoot>/.deploy-staging/<stagingId>/<name>`. Deterministic from (stagingId, component
	// name) so the activate phase can find what the stage phase built. Sits under the components
	// root (dirname(dirPath)) so the go-live rename() into `dirPath` stays on one filesystem and is
	// therefore atomic. Two properties fall out of putting the deployment id ABOVE the component name:
	//   - the leaf directory's basename IS the component name, so the pre-go-live validation load
	//     (componentLoader keys the ApplicationScope + status off basename) sees the real name, not a
	//     UUID; and
	//   - each deployment gets its OWN parent (.deploy-staging/<stagingId>), so a parallel or queued
	//     deploy of the same component never shares a directory — cleanup can't sweep a sibling.
	// See DEPLOY_STAGING_DIR.
	get stagingDirPath(): string {
		return join(dirname(this.dirPath), DEPLOY_STAGING_DIR, this.stagingId, this.name);
	}

	// The retained-previous copy this component would revert to (`.deploy-previous/<name>`). See
	// DEPLOY_PREVIOUS_DIR / activateStagedApplication / revertApplication.
	get previousDirPath(): string {
		return previousDirPathFor(this.dirPath);
	}

	// Route extract/install into the staging directory. Called by stageApplication().
	useStagingBuildDir(): void {
		this.#buildDirPath = this.stagingDirPath;
	}

	// Restore the live component directory as the build target. Called by activateStagedApplication()
	// once the staged copy has been swapped into place.
	useLiveBuildDir(): void {
		this.#buildDirPath = undefined;
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
export async function prepareApplication(application: Application) {
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
				let extraction: ExtractionTransaction | undefined;
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
						extraction = await extractApplication(application, true);
					} finally {
						await application.cleanupGitCredentialSession();
					}
					await installApplication(application);
					if (!application.isNewComponent) {
						const currentPackageMetadata = await readInstalledPackageMetadata(application.dirPath);
						application.packageMetadataChanged = installedRuntimeChanged(
							previousPackageMetadata,
							currentPackageMetadata,
							application.installationIsOpaque
						);
					}
					await extraction?.commit();
				} catch (error) {
					try {
						await extraction?.rollback();
					} catch (rollbackError) {
						throw new AggregateError(
							[error, rollbackError],
							`Failed to prepare ${application.name}: ${errorMessage(error)}; ` +
								`also failed to restore its previous component directory: ${errorMessage(rollbackError)}`
						);
					}
					throw error;
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

export function stagedApplicationPath(componentDirPath: string, deploymentId: string): string {
	if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) throw new Error(`Invalid deployment id '${deploymentId}'`);
	return join(dirname(componentDirPath), DEPLOY_STAGING_DIR, deploymentId, basename(componentDirPath));
}

async function ensureSecureDirectory(directory: string, create: boolean, description: string): Promise<boolean> {
	let directoryStat;
	try {
		directoryStat = await lstat(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		if (!create) return false;
		await mkdir(directory, { recursive: true, mode: 0o700 });
		directoryStat = await lstat(directory);
	}
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
		throw new Error(`${description} is not a directory: ${directory}`);
	}
	return true;
}

async function secureStagingDeploymentDirectory(
	componentDirPath: string,
	deploymentId: string,
	create: boolean
): Promise<string | undefined> {
	const stagingDirPath = stagedApplicationPath(componentDirPath, deploymentId);
	const deploymentDirPath = dirname(stagingDirPath);
	const stagingRoot = dirname(deploymentDirPath);
	if (!(await ensureSecureDirectory(stagingRoot, create, 'Component deploy staging path'))) return undefined;
	if (!(await ensureSecureDirectory(deploymentDirPath, create, 'Component deploy staging path'))) return undefined;
	return deploymentDirPath;
}

/** Build and install a candidate under .deploy-staging without mutating the live component tree. */
export async function stageApplication(application: Application, deploymentId: string): Promise<string> {
	const liveDirPath = application.dirPath;
	const stagingDirPath = stagedApplicationPath(liveDirPath, deploymentId);
	application.stagingId = deploymentId;
	application.useStagingBuildDir();
	try {
		await withComponentPreparationLock(liveDirPath, async () => {
			const deploymentDirPath = await secureStagingDeploymentDirectory(liveDirPath, deploymentId, true);
			await rm(stagingDirPath, { recursive: true, force: true });
			await rm(join(deploymentDirPath!, STAGED_COMPLETE_MARKER), { force: true });
			try {
				await application.writeTransientNpmrc();
				try {
					await application.startGitCredentialSession();
					await extractApplication(application);
				} finally {
					await application.cleanupGitCredentialSession();
				}
				await installApplication(application);
				await writeFile(
					join(deploymentDirPath!, STAGED_COMPLETE_MARKER),
					JSON.stringify({ installationIsOpaque: application.installationIsOpaque }),
					{ flag: 'wx', mode: 0o600 }
				);
			} catch (error) {
				await rm(stagingDirPath, { recursive: true, force: true }).catch(() => {});
				await rm(join(deploymentDirPath!, STAGED_COMPLETE_MARKER), { force: true }).catch(() => {});
				throw error;
			} finally {
				await application.cleanupTransientNpmrc();
			}
		});
	} finally {
		application.useLiveBuildDir();
	}
	await pruneStagedBuilds(application.name, deploymentId, getStagingRetentionMaxCount());
	return stagingDirPath;
}

function activationStagingDirectory(componentDirPath: string): string {
	return join(dirname(componentDirPath), DEPLOY_ACTIVATION_DIR, basename(componentDirPath));
}

async function activationArtifacts(componentDirPath: string, deploymentId: string): Promise<string[]> {
	const directory = activationStagingDirectory(componentDirPath);
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	return entries
		.filter(
			(entry) =>
				entry.name.startsWith(`${ACTIVATION_BACKUP_PREFIX}${deploymentId}`) ||
				entry.name === `${ACTIVATION_NEW_PREFIX}${deploymentId}`
		)
		.map((entry) => join(directory, entry.name));
}

export async function hasCompleteStagedApplication(stagingDirPath: string): Promise<boolean> {
	const deploymentDirPath = dirname(stagingDirPath);
	const [stagingRootStat, deploymentStat, stagedStat, stagedTargetStat, markerStat] = await Promise.all([
		lstat(dirname(deploymentDirPath)).catch(() => undefined),
		lstat(deploymentDirPath).catch(() => undefined),
		lstat(stagingDirPath).catch(() => undefined),
		stat(stagingDirPath).catch(() => undefined),
		lstat(join(deploymentDirPath, STAGED_COMPLETE_MARKER)).catch(() => undefined),
	]);
	return (
		!!stagingRootStat?.isDirectory() &&
		!stagingRootStat.isSymbolicLink() &&
		!!deploymentStat?.isDirectory() &&
		!deploymentStat.isSymbolicLink() &&
		!!stagedStat &&
		(stagedStat.isDirectory() || stagedStat.isSymbolicLink()) &&
		!!stagedTargetStat?.isDirectory() &&
		!!markerStat?.isFile() &&
		!markerStat.isSymbolicLink()
	);
}

/**
 * What the stage recorded about its own install. Falls back to "opaque" when the marker carries no
 * usable content: an unknown install has to be treated as one whose result can't be compared, so the
 * restart gate errs toward requiring a restart rather than silently skipping one.
 */
async function readStagedCompletion(stagingDirPath: string): Promise<{ installationIsOpaque: boolean }> {
	try {
		const raw = await readFile(join(dirname(stagingDirPath), STAGED_COMPLETE_MARKER), 'utf8');
		if (!raw.trim()) return { installationIsOpaque: true };
		return { installationIsOpaque: JSON.parse(raw)?.installationIsOpaque !== false };
	} catch {
		return { installationIsOpaque: true };
	}
}

/**
 * Re-point dependency links that the activation swap invalidated.
 *
 * `npm install` runs against the STAGING directory, and activation then renames that directory to the
 * live path. Any dependency npm materialized as a link with an ABSOLUTE target inside the staging
 * directory therefore dangles the moment the rename happens — the path it names no longer exists.
 *
 * This is the normal case for a `file:` dependency on Windows, where npm creates a directory JUNCTION
 * and junctions are always absolute. On Linux npm writes a relative symlink (`../vendor/probe`), which
 * survives the move untouched, which is why this only ever bites on Windows — the failure there is a
 * bare `Cannot find module '<dep>'` at component load, well after a deploy that reported success.
 *
 * Each such link is recreated pointing at the same relative location under the LIVE directory. Links
 * whose targets are relative, or absolute but outside the staging tree (a dependency deliberately
 * linked elsewhere on the machine), are left exactly as they are.
 */
async function repointStagedDependencyLinks(
	treeDirPath: string,
	futureLiveDirPath: string,
	currentTargetRootPath: string = treeDirPath
): Promise<number> {
	const nodeModulesPath = join(treeDirPath, 'node_modules');
	// The walk must stay inside the component's own node_modules. `readdir` FOLLOWS symlinks, so a staged
	// payload shipping `node_modules` (or a `node_modules/@scope`) as a link to somewhere else on the
	// machine would otherwise have its target's contents enumerated — and a link in there whose target
	// happened to point into staging would be removed and recreated, writing outside the component tree.
	// Requiring a real directory at each level we descend keeps every candidate under the real root.
	const nodeModulesStat = await lstat(nodeModulesPath).catch(() => undefined);
	if (!nodeModulesStat?.isDirectory() || nodeModulesStat.isSymbolicLink()) return 0;
	// Package links live at `node_modules/<name>` or `node_modules/@scope/<name>`, and npm nests a further
	// `node_modules` under a package whenever hoisting is blocked by a version conflict — routinely so
	// under workspaces. A link nested that way dangles after the swap exactly like a top-level one, so the
	// walk has to follow real nested trees rather than stopping at the first two levels.
	const candidates: string[] = [];
	const collect = async (directoryPath: string): Promise<void> => {
		for (const entry of await readdir(directoryPath, { withFileTypes: true }).catch(() => [])) {
			if (entry.name.startsWith('.')) continue;
			const entryPath = join(directoryPath, entry.name);
			if (entry.name.startsWith('@')) {
				// Only descend into a REAL directory: a symlinked scope directory belongs to whatever it points
				// at, not to this component (see the note on nodeModulesStat above).
				const scopeStat = await lstat(entryPath).catch(() => undefined);
				if (scopeStat?.isDirectory() && !scopeStat.isSymbolicLink()) await collect(entryPath);
				continue;
			}
			candidates.push(entryPath);
			const packageStat = await lstat(entryPath).catch(() => undefined);
			if (!packageStat?.isDirectory() || packageStat.isSymbolicLink()) continue;
			const nestedPath = join(entryPath, 'node_modules');
			const nestedStat = await lstat(nestedPath).catch(() => undefined);
			if (nestedStat?.isDirectory() && !nestedStat.isSymbolicLink()) await collect(nestedPath);
		}
	};
	await collect(nodeModulesPath);

	let repointed = 0;
	for (const linkPath of candidates) {
		const linkStat = await lstat(linkPath).catch(() => undefined);
		if (!linkStat?.isSymbolicLink()) continue;
		const target = await readlink(linkPath).catch(() => undefined);
		if (!target || !isAbsolute(target)) continue;
		// Belt-and-braces containment: never mutate a path that is not under the real node_modules root.
		const withinNodeModules = relative(nodeModulesPath, linkPath);
		if (withinNodeModules.startsWith('..') || isAbsolute(withinNodeModules)) continue;
		const withinStaging = relative(currentTargetRootPath, target);
		// `..` or an absolute result means the target is outside the staging tree — not ours to touch.
		if (!withinStaging || withinStaging.startsWith('..') || isAbsolute(withinStaging)) continue;
		// NOT best-effort. This link is only being touched because activation is about to invalidate its
		// target, so a failure here means the component goes live with a dangling dependency — which the
		// pre-swap load validation cannot catch, because the link was perfectly valid in staging. Throwing
		// keeps the old release live and returns an error, instead of reporting a successful deploy of a
		// component that cannot resolve its dependencies.
		await rm(linkPath, { force: true });
		await symlink(join(futureLiveDirPath, withinStaging), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
		repointed++;
	}
	return repointed;
}

/** Atomically replace the live component and compensate if persistent activation work fails. */
export async function activateStagedApplication(
	application: Application,
	deploymentId: string,
	hooks: {
		beforeSwap?: () => Promise<void>;
		beforeCommit?: () => Promise<void>;
		onRollback?: () => Promise<void>;
		/**
		 * The immutable activation specification this deployment is being activated with. Used only to
		 * derive the root-config entry recorded alongside the retained previous version, so a later
		 * `revert_component` can restore persistent config/install-lock state and not just the directory.
		 * Omit it and the swap still happens — the component just isn't revertable afterwards.
		 */
		activationSpec?: Record<string, any>;
	} = {}
): Promise<void> {
	const stagingDirPath = stagedApplicationPath(application.dirPath, deploymentId);
	await withComponentPreparationLock(application.dirPath, async () => {
		await secureStagingDeploymentDirectory(application.dirPath, deploymentId, false);
		if (!(await hasCompleteStagedApplication(stagingDirPath))) {
			const stagedStat = await lstat(stagingDirPath).catch(() => undefined);
			if (!stagedStat) {
				throw new Error(`Cannot activate ${application.name}: deployment '${deploymentId}' has no staged build`);
			}
			throw new Error(`Cannot activate ${application.name}: staged build is incomplete`);
		}

		const activationDir = activationStagingDirectory(application.dirPath);
		await ensureSecureDirectory(dirname(activationDir), true, 'Component activation staging path');
		await ensureSecureDirectory(activationDir, true, 'Component activation staging path');
		// Who is live right now, so the tree this activation displaces stays addressable for revert. Read
		// before the swap, since the swap is what makes it "previous".
		const outgoing: RetainedVersion = (await readRetainedPreviousManifest(application.dirPath).catch(() => undefined))
			?.live ?? {
			// No manifest yet: either a first-ever deploy, or a component last activated by a Harper that
			// predates retention. Record the config it is running so a revert can still restore that, even
			// though its deployment id is unknowable and so cannot be a revert target.
			deployment_id: null,
			application_config: readConfigFile()?.[application.name] ?? null,
		};
		const deployLifecycleId = await broadcastDeployStart(application.name);
		let backupPath: string | undefined;
		let newMarkerPath: string | undefined;
		let swapped = false;
		let repointedLinks = 0;
		try {
			await hooks.beforeSwap?.();
			const existingArtifacts = await activationArtifacts(application.dirPath, deploymentId);
			backupPath = existingArtifacts.find((candidate) => basename(candidate).startsWith(ACTIVATION_BACKUP_PREFIX));
			newMarkerPath = existingArtifacts.find((candidate) => basename(candidate).startsWith(ACTIVATION_NEW_PREFIX));
			if (!backupPath && !newMarkerPath) {
				try {
					await lstat(application.dirPath);
					application.isNewComponent = false;
					// Installed package metadata sits outside most plugin watch globs, so no file watcher sees a
					// dependency or module-entry change — but it does invalidate already-loaded code. The one-shot
					// path compares it across its in-place install (prepareApplication); the two-phase path has to
					// compare the outgoing live tree against the staged one, which is only possible here, while
					// both still exist. Feeds markRestartRequiredForDeploy (harper#674, harper#1849 @heskew).
					application.packageMetadataChanged = installedRuntimeChanged(
						await readInstalledPackageMetadata(application.dirPath),
						await readInstalledPackageMetadata(stagingDirPath),
						(await readStagedCompletion(stagingDirPath)).installationIsOpaque
					);
					backupPath = join(
						activationDir,
						`${ACTIVATION_BACKUP_PREFIX}${deploymentId}-${Date.now()}-${process.pid}-${randomUUID()}`
					);
					await rename(application.dirPath, backupPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
					application.isNewComponent = true;
					newMarkerPath = join(activationDir, `${ACTIVATION_NEW_PREFIX}${deploymentId}`);
					try {
						await writeFile(newMarkerPath, '', { flag: 'wx', mode: 0o600 });
					} catch (markerError) {
						if ((markerError as NodeJS.ErrnoException).code !== 'EEXIST') throw markerError;
						const markerStat = await lstat(newMarkerPath);
						if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
							throw new Error(`Component activation marker is not a regular file: ${newMarkerPath}`);
						}
					}
				}
			}
			// Re-point dependency links BEFORE the swap and inside the transaction. npm installed against the
			// staging path, so any link it created with an absolute target inside staging is about to become
			// dangling; rewriting them to their future live targets now means a failure lands in the catch
			// below, which restores the previous release rather than leaving a live component that cannot
			// resolve its dependencies. Done pre-swap for the compensation, not post-swap for convenience.
			repointedLinks = await repointStagedDependencyLinks(stagingDirPath, application.dirPath);
			if (repointedLinks) {
				logger.debug?.(
					`Re-pointed ${repointedLinks} dependency link(s) in ${application.name} from the staging path to the live path`
				);
			}
			await rename(stagingDirPath, application.dirPath);
			swapped = true;
			await hooks.beforeCommit?.();
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			if (swapped) {
				try {
					await rename(application.dirPath, stagingDirPath);
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			if (repointedLinks) {
				// The candidate is going back to staging, so its links have to point at staging again. Left
				// aimed at the live path they would resolve against whatever release is live, so a retry of
				// this same deployment id would validate the staged tree against the wrong bytes.
				try {
					// The candidate now sits at the staging path (moved back above, or never swapped), while its
					// links still point at the live path: walk it there, and aim them back at staging.
					await repointStagedDependencyLinks(stagingDirPath, stagingDirPath, application.dirPath);
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			if (backupPath) {
				try {
					await rename(backupPath, application.dirPath);
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			if (newMarkerPath)
				await rm(newMarkerPath, { force: true }).catch((rollbackError) => rollbackErrors.push(rollbackError));
			try {
				await hooks.onRollback?.();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			if (rollbackErrors.length) {
				throw new AggregateError(
					[error, ...rollbackErrors],
					`Failed to activate and fully restore ${application.name}`
				);
			}
			throw error;
		} finally {
			broadcastDeployEnd(application.name, deployLifecycleId);
		}
		// The displaced tree is the component's rollback source now, not garbage: retain it as
		// `.deploy-previous/<name>` with a manifest recording which deployment produced it. Best-effort —
		// a component that can't retain its previous version is still deployed, just not revertable.
		await retainActivatedPrevious(
			application,
			backupPath,
			deploymentId,
			hooks.activationSpec ? applicationConfigFromActivationSpec(hooks.activationSpec) : undefined,
			outgoing
		);
		if (newMarkerPath) await rm(newMarkerPath, { force: true });
		await rmdir(activationDir).catch((error) => {
			if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
		});
	});
	await rm(dirname(stagingDirPath), { recursive: true, force: true }).catch((error) =>
		logger.warn(`Failed to remove committed deploy staging for ${application.name}:`, errorForLog(error))
	);
}

export async function discardStagedApplication(componentDirPath: string, deploymentId: string): Promise<void> {
	const stagingDirPath = stagedApplicationPath(componentDirPath, deploymentId);
	await withComponentPreparationLock(componentDirPath, async () => {
		if (!(await secureStagingDeploymentDirectory(componentDirPath, deploymentId, false))) return;
		await rm(dirname(stagingDirPath), { recursive: true, force: true });
	});
}

export async function discardProjectStagedApplications(componentDirPath: string): Promise<void> {
	const stagingRoot = join(dirname(componentDirPath), DEPLOY_STAGING_DIR);
	if (!(await ensureSecureDirectory(stagingRoot, false, 'Component deploy staging path'))) return;
	for (const entry of await readdir(stagingRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !DEPLOYMENT_ID_PATTERN.test(entry.name)) continue;
		const deploymentDirPath = join(stagingRoot, entry.name);
		if (existsSync(join(deploymentDirPath, basename(componentDirPath)))) {
			await rm(deploymentDirPath, { recursive: true, force: true });
		}
	}
}

export async function discardProjectActivationArtifacts(componentDirPath: string): Promise<void> {
	const activationRoot = join(dirname(componentDirPath), DEPLOY_ACTIVATION_DIR);
	if (!(await ensureSecureDirectory(activationRoot, false, 'Component activation staging path'))) return;
	await rm(activationStagingDirectory(componentDirPath), { recursive: true, force: true });
	await rmdir(activationRoot).catch((error) => {
		if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
	});
}

type DeploymentLookup = (deploymentId: string) => Promise<Record<string, any> | undefined>;

function safeComponentName(name: unknown): name is string {
	return typeof name === 'string' && /^[a-zA-Z0-9_-]+$/.test(name);
}

function activationArtifactDeploymentId(name: string): string | undefined {
	const prefix = name.startsWith(ACTIVATION_BACKUP_PREFIX)
		? ACTIVATION_BACKUP_PREFIX
		: name.startsWith(ACTIVATION_NEW_PREFIX)
			? ACTIVATION_NEW_PREFIX
			: undefined;
	if (!prefix) return undefined;
	const deploymentId = name.slice(prefix.length, prefix.length + 36);
	return DEPLOYMENT_ID_PATTERN.test(deploymentId) ? deploymentId : undefined;
}

async function removeActivationArtifacts(componentDirPath: string, deploymentId: string): Promise<void> {
	for (const artifact of await activationArtifacts(componentDirPath, deploymentId)) {
		await rm(artifact, { recursive: true, force: true });
	}
	await rmdir(activationStagingDirectory(componentDirPath)).catch(() => {});
}

export async function reconcileStagedApplicationArtifacts(
	componentsRootDirPath: string,
	getDeployment: DeploymentLookup,
	persistActivation: (row: Record<string, any>) => Promise<void>,
	settleStagedDeployment?: (deploymentId: string) => Promise<void>
): Promise<{
	recovered: string[];
	removed: string[];
	errors: Map<string, Error>;
	failedProjects: Map<string, Error>;
}> {
	const recovered = new Set<string>();
	const removed: string[] = [];
	const errors = new Map<string, Error>();
	// Same failures as `errors`, keyed by COMPONENT rather than deployment id. An activation whose
	// persistent work could not be completed leaves the live tree and its durable configuration
	// disagreeing, so the caller has to be able to keep that specific component from loading — which it
	// cannot do from a deployment id.
	const failedProjects = new Map<string, Error>();
	const stagingRoot = join(componentsRootDirPath, DEPLOY_STAGING_DIR);
	let deploymentEntries = [];
	try {
		if (await ensureSecureDirectory(stagingRoot, false, 'Component deploy staging path')) {
			deploymentEntries = await readdir(stagingRoot, { withFileTypes: true });
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}

	for (const entry of deploymentEntries) {
		const deploymentPath = join(stagingRoot, entry.name);
		if (!entry.isDirectory() || !DEPLOYMENT_ID_PATTERN.test(entry.name)) {
			await rm(deploymentPath, { recursive: true, force: true });
			removed.push(entry.name);
			continue;
		}
		// Declared outside the try so the catch can attribute a reconciliation failure to its component.
		let row: Record<string, any> | undefined;
		try {
			row = await getDeployment(entry.name);
			if (!row || !safeComponentName(row.project)) {
				await rm(deploymentPath, { recursive: true, force: true });
				removed.push(entry.name);
				continue;
			}
			const componentDirPath = join(componentsRootDirPath, row.project);
			if (!['staged', 'activating'].includes(row.status)) {
				let shouldRemove = false;
				await withComponentPreparationLock(componentDirPath, async () => {
					row = await getDeployment(entry.name);
					shouldRemove = !row || !safeComponentName(row.project) || !['staged', 'activating'].includes(row.status);
					if (shouldRemove) await rm(deploymentPath, { recursive: true, force: true });
				});
				if (shouldRemove) {
					removed.push(entry.name);
					continue;
				}
			}
			const stagedPath = stagedApplicationPath(componentDirPath, entry.name);
			if (row.status === 'staged') {
				if (!(await hasCompleteStagedApplication(stagedPath))) {
					let discarded = false;
					await withComponentPreparationLock(componentDirPath, async () => {
						// Re-read under the lock. The check above is an unlocked fast path, so an activation may
						// have swapped this candidate in and cleaned it up since.
						if (await hasCompleteStagedApplication(stagedPath)) return;
						// Only a not-yet-activated candidate is broken; the live tree and its persisted config are
						// consistent. Failing the component closed here would take a healthy component offline and
						// keep it offline, because nothing else sweeps a staging directory whose subtree is missing.
						logger.warn(
							`Discarding staged deployment '${entry.name}' for '${row.project}': no valid component tree. ` +
								`The live component is unaffected.`
						);
						await settleStagedDeployment?.(entry.name);
						await rm(deploymentPath, { recursive: true, force: true });
						discarded = true;
					});
					if (discarded) removed.push(entry.name);
				}
				continue;
			}
			if (await hasCompleteStagedApplication(stagedPath)) {
				await activateStagedApplication(new Application({ name: row.project }), entry.name, {
					beforeCommit: () => persistActivation(row),
					// A recovered roll-forward retains its displaced tree the same as a normal activation, so a
					// deploy that crashed mid-swap is still revertable once the node is back up.
					activationSpec: row.activation_spec,
				});
			} else {
				let ownedByActivation = false;
				await withComponentPreparationLock(componentDirPath, async () => {
					// Re-read under the lock for the same reason as the `staged` branch above: if a complete
					// candidate is here now, an in-flight activation owns these artifacts and will settle them.
					if (await hasCompleteStagedApplication(stagedPath)) {
						ownedByActivation = true;
						return;
					}
					const liveStat = await lstat(componentDirPath).catch(() => undefined);
					if (!liveStat?.isDirectory() || liveStat.isSymbolicLink()) {
						throw new Error(`Interrupted activation '${entry.name}' has neither a staged nor live component tree`);
					}
					await persistActivation(row);
				});
				if (ownedByActivation) continue;
			}
			await removeActivationArtifacts(componentDirPath, entry.name);
			recovered.add(entry.name);
		} catch (error) {
			const reconcileError = error instanceof Error ? error : new Error(String(error));
			errors.set(entry.name, reconcileError);
			// Fail the component closed for an interrupted activation, where the live tree and its durable
			// configuration can disagree. A confirmed `staged` failure leaves live state consistent, so it
			// does not. When the lookup itself failed there is no project name to attribute to — but nothing
			// destructive has run for this entry either, and a non-empty `errors` keeps the reconcile guard
			// unset so the next reload cycle retries.
			if (row?.status === 'activating' && safeComponentName(row?.project)) {
				failedProjects.set(row.project, reconcileError);
			}
		}
	}

	const activationRoot = join(componentsRootDirPath, DEPLOY_ACTIVATION_DIR);
	if (await ensureSecureDirectory(activationRoot, false, 'Component activation staging path')) {
		for (const projectEntry of await readdir(activationRoot, { withFileTypes: true })) {
			const projectPath = join(activationRoot, projectEntry.name);
			if (!projectEntry.isDirectory() || !safeComponentName(projectEntry.name)) {
				await rm(projectPath, { recursive: true, force: true });
				continue;
			}
			const livePath = join(componentsRootDirPath, projectEntry.name);
			// This sweep renames a backup back over the live path, so it must hold the lock every other
			// mutator of that path holds. A reload cycle can retry reconciliation while an activation is
			// mid-swap, and an unlocked sweep would restore the backup underneath it — after which the
			// in-flight rename fails ENOTEMPTY and its own compensation fails ENOENT. Waiting out a live
			// owner is what makes the decisions below sound: they are read from settled state, not a
			// half-finished swap.
			await withComponentPreparationLock(livePath, async () => {
				for (const artifact of await readdir(projectPath, { withFileTypes: true })) {
					const deploymentId = activationArtifactDeploymentId(artifact.name);
					const artifactPath = join(projectPath, artifact.name);
					if (!deploymentId) {
						await rm(artifactPath, { recursive: true, force: true });
						continue;
					}
					let row: Record<string, any> | undefined;
					try {
						row = await getDeployment(deploymentId);
					} catch (lookupError) {
						// Cannot tell absent from unreadable, so destroy nothing and fail the component closed.
						const reconcileError = lookupError instanceof Error ? lookupError : new Error(String(lookupError));
						errors.set(deploymentId, reconcileError);
						failedProjects.set(projectEntry.name, reconcileError);
						continue;
					}
					const liveStat = await lstat(livePath).catch(() => undefined);
					if (row?.status === 'activating' && row.project === projectEntry.name && liveStat?.isDirectory()) {
						try {
							await persistActivation(row);
							await rm(artifactPath, { recursive: true, force: true });
							recovered.add(deploymentId);
						} catch (error) {
							const reconcileError = error instanceof Error ? error : new Error(String(error));
							errors.set(deploymentId, reconcileError);
							failedProjects.set(projectEntry.name, reconcileError);
						}
					} else if (artifact.name.startsWith(ACTIVATION_BACKUP_PREFIX) && !liveStat) {
						await rename(artifactPath, livePath);
					} else {
						await rm(artifactPath, { recursive: true, force: true });
					}
				}
			});
			await rmdir(projectPath).catch(() => {});
		}
		await rmdir(activationRoot).catch(() => {});
	}
	await rmdir(stagingRoot).catch(() => {});
	return { recovered: [...recovered], removed, errors, failedProjects };
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

const PERSISTENT_STATE_LOCK_PURPOSE = 'application-persistent-state';

function persistentStateLockPath(): string {
	return join(getConfigValue(CONFIG_PARAMS.ROOTPATH), 'harper-application-lock.json');
}

/**
 * Serialize a root-config + application-lock read-modify-write across every isolate and process. The
 * snapshot and both files have to sit inside one critical section: the entries are per-project but the
 * files are shared, so an unsynchronized read-modify-write drops a sibling project's entry.
 *
 * Never call this while already holding it — the file lock is not reentrant. The `*Unlocked` variants
 * exist for callers that are already inside it.
 */
async function withPersistentStateLock<T>(operation: () => Promise<T>): Promise<T> {
	return withComponentPreparationLock(persistentStateLockPath(), operation, {
		purpose: PERSISTENT_STATE_LOCK_PURPOSE,
		timeoutMs: 30_000,
	});
}

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

function applicationConfigFromActivationSpec(spec: Record<string, any>): ApplicationConfig | undefined {
	if (!spec.package) return undefined;
	const applicationConfig: ApplicationConfig = { package: spec.package };
	if (spec.install_command !== null || spec.install_timeout !== null || spec.install_allow_scripts !== null) {
		applicationConfig.install = {};
		if (spec.install_command !== null) applicationConfig.install.command = spec.install_command;
		if (spec.install_timeout !== null) applicationConfig.install.timeout = spec.install_timeout;
		if (spec.install_allow_scripts !== null) applicationConfig.install.allowInstallScripts = spec.install_allow_scripts;
	}
	if (spec.urlPath !== null) applicationConfig.urlPath = spec.urlPath;
	if (spec.host !== null) applicationConfig.host = spec.host;
	if (spec.credentials?.length) applicationConfig.credentials = spec.credentials;
	return applicationConfig;
}

async function readApplicationLock(lockPath: string): Promise<{ applications: Record<string, ApplicationConfig> }> {
	try {
		const lock = JSON.parse(await readFile(lockPath, 'utf8'));
		if (!lock.applications || typeof lock.applications !== 'object') lock.applications = {};
		return lock;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { applications: {} };
		throw error;
	}
}

/** Persist a runtime activation into the boot-time application lock, or remove it during compensation. */
export async function updateApplicationLockEntry(
	name: string,
	applicationConfig: ApplicationConfig | undefined
): Promise<void> {
	return withPersistentStateLock(() => updateApplicationLockEntryUnlocked(name, applicationConfig));
}

async function updateApplicationLockEntryUnlocked(
	name: string,
	applicationConfig: ApplicationConfig | undefined
): Promise<void> {
	const lockPath = join(getConfigValue(CONFIG_PARAMS.ROOTPATH), 'harper-application-lock.json');
	const previous = applicationLockWriteQueues.get(lockPath) ?? Promise.resolve();
	const next = previous
		.catch(() => {})
		.then(async () => {
			const lock = await readApplicationLock(lockPath);
			if (applicationConfig === undefined) delete lock.applications[name];
			else lock.applications[name] = applicationConfig;
			const tempPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
			await writeFile(tempPath, JSON.stringify(lock, null, 2), 'utf8');
			await rename(tempPath, lockPath);
		});
	applicationLockWriteQueues.set(lockPath, next);
	await next;
}

async function getApplicationLockEntryUnlocked(name: string): Promise<ApplicationConfig | undefined> {
	const lockPath = join(getConfigValue(CONFIG_PARAMS.ROOTPATH), 'harper-application-lock.json');
	const previous = applicationLockWriteQueues.get(lockPath) ?? Promise.resolve();
	let entry: ApplicationConfig | undefined;
	const read = previous
		.catch(() => {})
		.then(async () => {
			entry = (await readApplicationLock(lockPath)).applications[name];
		});
	applicationLockWriteQueues.set(lockPath, read);
	await read;
	return entry;
}

/**
 * Move a component's persisted root-config entry and boot-time install-lock entry to `nextConfig` as
 * one reversible step, snapshotting the current values at commit time so `rollback()` restores exactly
 * what was there.
 *
 * `nextConfig: null` is an instruction to REMOVE the entry, not to leave it alone — the case that
 * matters when reverting away from a `package` deploy to a payload one, where a stale `package:` entry
 * would let installApplications() reinstall the reverted-away version on the next cold start.
 * `undefined` means "this caller has nothing to say about config" and the transaction is a no-op.
 */
export async function createApplicationConfigTransaction(
	project: string,
	nextConfig: ApplicationConfig | null | undefined
): Promise<{ commit(): Promise<void>; rollback(): Promise<void> }> {
	if (nextConfig === undefined) return { commit: async () => {}, rollback: async () => {} };
	let previousConfig: ApplicationConfig | undefined;
	let previousLockConfig: ApplicationConfig | undefined;
	let commitStarted = false;
	return {
		async commit() {
			if (commitStarted) return;
			// Snapshot and both writes inside one critical section, so a concurrent activation of a different
			// project cannot land between the read and the write and lose one of the two entries.
			await withPersistentStateLock(async () => {
				previousConfig = readConfigFile()?.[project];
				previousLockConfig = await getApplicationLockEntryUnlocked(project);
				commitStarted = true;
				if (nextConfig === null) deleteConfigFromFile([project]);
				else await addConfig(project, nextConfig);
				await updateApplicationLockEntryUnlocked(project, nextConfig ?? undefined);
			});
		},
		async rollback() {
			if (!commitStarted) return;
			await withPersistentStateLock(async () => {
				if (previousConfig === undefined) deleteConfigFromFile([project]);
				else await addConfig(project, previousConfig);
				await updateApplicationLockEntryUnlocked(project, previousLockConfig);
				commitStarted = false;
			});
		},
	};
}

export async function createApplicationActivationTransaction(
	project: string,
	spec: Record<string, any>
): Promise<{ commit(): Promise<void>; rollback(): Promise<void> }> {
	// A payload deploy has no package reference to persist, so activating from it says nothing about
	// root config and must leave whatever is there alone (undefined, not null).
	return createApplicationConfigTransaction(project, applicationConfigFromActivationSpec(spec));
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
