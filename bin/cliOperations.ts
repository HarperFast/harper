'use strict';

import { loadCredentials, saveCredentials, normalizeTarget, extractTargetCredentials } from './cliCredentials.ts';
import { isJWTExpired } from '../security/tokenAuthentication.ts';
import * as envMgr from '../utility/environment/environmentManager.ts';
envMgr.initSync();
import * as terms from '../utility/hdbTerms.ts';
import { httpRequest } from '../utility/common_utils.ts';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as YAML from 'yaml';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { streamPackagedDirectory, packageDirectory, scanPackageDirectory } from '../components/packageComponent.ts';
import { normalizeGitHost } from '../components/gitCredentialServer.ts';
import { encode as encodeCbor } from 'cbor-x';
import { buildMultipartBody } from './multipartBuilder.ts';
import { parseSSE } from './sseConsumer.ts';
import { DeployRenderer } from './deployRenderer.ts';
import { getHdbPid } from '../utility/processManagement/processManagement.js';
import { initConfig, getConfigPath } from '../config/configUtils.ts';

const OP_ALIASES = { deploy: 'deploy_component', package: 'package_component' };

// Shown for any local-instance connection failure (missing pid, missing/stale domain
// socket, or a refused/ENOENT connect against it) — they're all the same user-facing
// scenario: Harper isn't running. Remote-target failures keep the detailed error instead,
// since there's no single "just start it" fix for those.
const LOCAL_NOT_RUNNING_MESSAGE = 'Harper is not running. Use `harperdb run` (or `harperdb start`) to start it.';

// Operations whose responses should be consumed as text/event-stream so live phase events
// (prepare, load, replicate, restart) render as they happen instead of after the whole
// deploy completes. Add an operation here only after wiring its server-side
// SSE_PROGRESS_OPERATIONS entry — otherwise the server returns the buffered JSON path and
// the SSE parser sees no events.
const SSE_OPERATIONS = new Set(['deploy_component']);

// Properties on `req` that the CLI itself uses for transport/UX, not the operations API.
// They never get serialized into the request body. `username`/`password` are deliberately
// NOT here: those args are payload fields (e.g. the user add_user/alter_user create/alter),
// not transport — use `auth_username`/`auth_password` (or env-var/`harper login` auth) to
// authenticate as a different user than the one being operated on.
const TRANSPORT_ONLY_FIELDS = new Set([
	'target',
	'auth_username',
	'auth_password',
	'rejectUnauthorized',
	'json',
	'skip_node_modules',
	'skip_symlinks',
	// deploy-by-reference opt-in: consumed client-side to build `package` (and derive `credentials`),
	// never sent to the server. (`credentials`, plural, IS a real operation field and is sent.)
	'by_ref',
	'ref',
	'credential',
]);

// Values that are opaque strings, never JSON. buildRequest otherwise JSON-parses every value, which
// silently rewrites a git ref that happens to look numeric: `ref=1.0` becomes the number 1 (and then
// the string "1"), so a tag named "1.0" would be resolved as "1". Refs can't be anything but strings.
const RAW_STRING_FIELDS = new Set(['ref']);

// Streaming (multipart upload + SSE progress) deploy was introduced in 5.1.0. A CLI at >=
// 5.1 talking to a server < 5.1 must not use it: the older server has no multipart body
// parser (the upload is rejected) and its generic text/event-stream serializer emits a bare
// `data:` frame with no `done` event (so the CLI reads no result — "Deploy completed (no
// result payload)."). For those targets we fall back to the legacy deploy transport: the
// tarball rides as a native binary `payload` in a CBOR-encoded body — exactly what the
// pre-5.1 CLI sent (Content-Type: application/cbor) — so it stays compact (~1x) instead of
// ballooning as a base64 string (~1.33x) or a {type,data} JSON byte array (~5x).
const STREAMING_DEPLOY_MIN_MAJOR = 5;
const STREAMING_DEPLOY_MIN_MINOR = 1;

// Idle-socket timeout for CLI Op-API requests: no traffic (in either direction) for this long
// means the target is unreachable or wedged. Resets on any activity, so a slow-but-active
// upload/deploy is unaffected — only a fully silent connection trips it. Overridable for
// operations against known-slow targets.
//
// SSE-based operations (see SSE_OPERATIONS above) get a much longer default: a long-running
// deploy_component can go quiet between phase events (e.g. a slow replicate/load step) for well
// over a minute even though the connection is perfectly healthy, so the generic 60s default is
// too tight for this one. HARPER_CLI_TIMEOUT_MS/CLI_TIMEOUT_MS, when set, overrides BOTH
// defaults uniformly — it's a single "I know what timeout I want" escape hatch rather than two
// separate env vars to keep in sync.
const DEFAULT_CLI_OPERATION_TIMEOUT_MS = 60000;
const DEFAULT_SSE_OPERATION_TIMEOUT_MS = 600000; // 10 minutes
// Largest delay Node's setTimeout accepts; a larger value is silently coerced and fires in
// ~1ms instead of the intended delay, so out-of-range input is treated the same as any other
// invalid input below (falls back to DEFAULT_CLI_OPERATION_TIMEOUT_MS) rather than passed through.
const MAX_CLI_OPERATION_TIMEOUT_MS = 2147483647; // 2^31 - 1
const RAW_CLI_OPERATION_TIMEOUT = (process.env.HARPER_CLI_TIMEOUT_MS || process.env.CLI_TIMEOUT_MS)?.trim();
const PARSED_CLI_OPERATION_TIMEOUT = RAW_CLI_OPERATION_TIMEOUT ? Number(RAW_CLI_OPERATION_TIMEOUT) : NaN;
const CLI_OPERATION_TIMEOUT_OVERRIDE_MS =
	Number.isInteger(PARSED_CLI_OPERATION_TIMEOUT) &&
	PARSED_CLI_OPERATION_TIMEOUT >= 0 &&
	PARSED_CLI_OPERATION_TIMEOUT <= MAX_CLI_OPERATION_TIMEOUT_MS
		? PARSED_CLI_OPERATION_TIMEOUT
		: undefined;
const CLI_OPERATION_TIMEOUT_MS = CLI_OPERATION_TIMEOUT_OVERRIDE_MS ?? DEFAULT_CLI_OPERATION_TIMEOUT_MS;
const SSE_OPERATION_TIMEOUT_MS = CLI_OPERATION_TIMEOUT_OVERRIDE_MS ?? DEFAULT_SSE_OPERATION_TIMEOUT_MS;

/**
 * Parses a Harper version string (e.g. "5.0.31", "5.1.0-beta.2") and reports whether the
 * server is new enough to accept the multipart + SSE streaming deploy. Unparseable input
 * returns true so we never downgrade a deploy against a server we simply can't classify.
 */
function versionSupportsStreamingDeploy(version: unknown): boolean {
	if (typeof version !== 'string') return true;
	const match = version.match(/^(\d+)\.(\d+)/);
	if (!match) return true;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (major !== STREAMING_DEPLOY_MIN_MAJOR) return major > STREAMING_DEPLOY_MIN_MAJOR;
	return minor >= STREAMING_DEPLOY_MIN_MINOR;
}

/**
 * Probes a remote target's Harper version via `registration_info` (a lightweight, long-lived
 * operation present on both < 5.1 and >= 5.1 servers that returns `{ version }`) to decide
 * whether the streaming deploy protocol is supported. Any probe failure — non-200, missing
 * version, network error — resolves to `true` (assume modern) so we never break a deploy
 * that would otherwise have worked; we only downgrade on a positive "older than 5.1" reading.
 */
async function targetSupportsStreamingDeploy(options: any): Promise<boolean> {
	try {
		const probeOptions = {
			...options,
			headers: { ...options.headers, Accept: 'application/json' },
			timeout: CLI_OPERATION_TIMEOUT_MS,
		};
		delete probeOptions.streamResponse;
		const response = await httpRequest(probeOptions, { operation: 'registration_info' });
		if (response.statusCode !== 200 || !response.body) return true;
		const version = JSON.parse(response.body)?.version;
		return versionSupportsStreamingDeploy(version);
	} catch {
		return true;
	}
}

// Wraps the local packaging stream so an fs error while tar'ing up the payload (e.g. a file
// vanishing after the pre-deploy scan, or a permissions failure reading the project tree)
// surfaces as a descriptive packaging error instead of a raw fs error code. Without this, an
// ENOENT from *packaging* is indistinguishable from an ENOENT/ECONNREFUSED connecting to the
// local domain socket, and the catch block below (which classifies purely on err.code) would
// misreport it as "Harper is not running" even though Harper is running fine. Mirrors the
// legacy deploy path's wrapping of packageDirectory() below.
async function* wrapPackagingStream(stream: Readable, projectPath: string): AsyncGenerator<Buffer> {
	try {
		for await (const chunk of stream) yield chunk as Buffer;
	} catch (err: any) {
		throw new Error(`Failed to package component directory '${projectPath}': ${err.message}`, { cause: err });
	}
}

// Build the JSON operation-field set from `req`, dropping the CLI's internal (`_`-prefixed)
// and transport-only fields so neither the CLI internals nor credentials leak into the
// request body. Shared by the multipart and legacy-JSON deploy body builders.
function operationFields(req: any): any {
	const fields: any = {};
	for (const [key, value] of Object.entries(req)) {
		if (key.startsWith('_') || TRANSPORT_ONLY_FIELDS.has(key)) continue;
		fields[key] = value;
	}
	return fields;
}

function basicAuthHeader(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/**
 * Picks the HTTP Basic credentials for a targeted operation from the first source that supplies
 * any, in precedence order: the dedicated `auth_username=`/`auth_password=` args, then userinfo
 * embedded in the target URL, then each env-var pair. Every source is all-or-nothing: pairing one
 * source's username with another's password would send one identity's name with a different
 * identity's secret, so a half-specified source is never completed from the next one (an empty
 * value — a blank CI variable, say — counts as specified-but-missing).
 *
 * Returns undefined when no source is configured at all, which leaves authentication to the saved
 * `harper login` token and, failing that, the legacy `username=`/`password=` payload fallback.
 */
function resolveTransportCredentials(req: any, urlCredentials: { username: string; password: string }) {
	const sources = [
		{
			name: '`auth_username=`/`auth_password=`',
			username: req.auth_username,
			password: req.auth_password,
			incompleteIsFatal: true,
		},
		{
			name: 'the target URL',
			// A URL with no userinfo yields empty strings, which here mean "absent" — unlike an
			// explicitly passed empty value, there is nothing for the user to have gotten wrong.
			username: urlCredentials.username || undefined,
			password: urlCredentials.password || undefined,
			incompleteIsFatal: true,
		},
		{
			name: 'HARPER_CLI_USERNAME/HARPER_CLI_PASSWORD',
			username: process.env.HARPER_CLI_USERNAME,
			password: process.env.HARPER_CLI_PASSWORD,
			incompleteIsFatal: false,
		},
		{
			name: 'CLI_TARGET_USERNAME/CLI_TARGET_PASSWORD',
			username: process.env.CLI_TARGET_USERNAME,
			password: process.env.CLI_TARGET_PASSWORD,
			incompleteIsFatal: false,
		},
	];
	// A source counts as configured once either half is *supplied*, empty or not: `auth_username=`
	// with an unset CI variable behind it is a broken credential, and quietly falling through to a
	// saved admin token would run the command as the wrong identity.
	for (const { name, username, password, incompleteIsFatal } of sources) {
		if (username === undefined && password === undefined) continue;
		if (!username || !password) {
			const missing = username ? 'a password' : password ? 'a username' : 'a username and a password';
			const detail = `${name} is missing ${missing}, and credentials are never combined across sources`;
			// Credentials passed explicitly for this command have no other purpose, so an
			// incomplete pair is a mistake worth failing on. The env vars double as `harper login`
			// inputs — a lone HARPER_CLI_USERNAME or HARPER_CLI_PASSWORD is a supported login idiom
			// with the other half prompted for — so an incomplete pair there is skipped with a
			// warning instead of breaking every later operation in the same shell or CI job.
			if (incompleteIsFatal) throw new Error(`Incomplete credentials: ${detail}.`);
			console.error(`Ignoring incomplete credentials: ${detail}.`);
			continue;
		}
		return { username, password };
	}
}

// Secret-valued CLI args, whatever their role (transport auth or operation payload). Logging a
// parsed CLI request must go through redactCredentials() so a password doesn't land in the log
// file — the command line already exposes it to shell history and process listings; the log
// shouldn't be a third copy. This list is by field name, not exhaustive — any future secret-bearing
// arg (a token, a key) needs to be added here explicitly, or it will reach logger.trace unredacted.
const SECRET_FIELDS = new Set(['auth_password', 'password']);

// `target=https://admin:secret@host` carries a password too, so masking the userinfo is part of
// making a target printable — the same string is echoed by the "Connecting to ..." line.
function redactTargetUrl(target: unknown): unknown {
	if (typeof target !== 'string') return target;
	try {
		const url = new URL(target);
		if (!url.password) return target;
		url.password = '***';
		return url.toString();
	} catch {
		return target;
	}
}

function redactCredentials(req: any): any {
	const redacted: any = {};
	for (const [key, value] of Object.entries(req)) {
		if (SECRET_FIELDS.has(key) && value) redacted[key] = '***';
		else if (key === 'target') redacted[key] = redactTargetUrl(value);
		else redacted[key] = value;
	}
	return redacted;
}

export {
	cliOperations,
	buildRequest,
	redactCredentials,
	refreshExpiredOperationToken,
	resolveGitTarget,
	resolveCredentialHost,
	deriveGitSecretName,
};

// --- deploy-by-reference (opt-in via `by_ref=true` / `ref=<committish>`) ----------------------
// Resolve the app's GitHub repo + commit from the local working copy (or GitHub Actions env) so
// `harper deploy by_ref=true` deploys a pinned commit by reference instead of uploading a payload
// blob. Client-side: only the runner has the git context. The no-flag default stays the payload deploy.

// resolveGitRepo only recognizes GitHub remotes, so every by_ref package clones from this host. The
// credential host is derived from it rather than taken on the user's word (see resolveCredentialHost).
const GIT_PACKAGE_HOST = 'github.com';
// SHA-1 (40) or SHA-256 (64) object IDs. A full object ID is already immutable, so it's the one form
// of ref that needs no resolution; every other form can move.
const FULL_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
// `ls-remote` reaches the network, where git will otherwise block indefinitely on an interactive
// credential prompt the CLI can't render. Fail fast instead, and cap the whole call.
const NON_INTERACTIVE_GIT_ENV = {
	GIT_TERMINAL_PROMPT: '0',
	GIT_ASKPASS: 'echo',
	SSH_ASKPASS: 'echo',
	GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
};
const GIT_NETWORK_TIMEOUT_MS = 15000;

function runGit(args: string[]): string {
	return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function runGitNetwork(args: string[]): string {
	return execFileSync('git', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
		env: { ...process.env, ...NON_INTERACTIVE_GIT_ENV },
		timeout: GIT_NETWORK_TIMEOUT_MS,
	}).trim();
}

function resolveGitRepo(): string {
	if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
	let url: string;
	try {
		url = runGit(['remote', 'get-url', 'origin']);
	} catch {
		throw new Error(
			'deploy by_ref: no git `origin` remote found — push this project to GitHub, or pass an explicit package=.'
		);
	}
	// git@github.com:owner/repo.git | https://github.com/owner/repo(.git) | ssh://…
	const match = url.match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
	if (!match) throw new Error(`deploy by_ref: could not parse owner/repo from the origin remote: ${url}`);
	return match[1];
}

// Prefer the configured `origin`: it carries whatever credentials, mirrors, and url.insteadOf
// rewriting the user's git is already set up with. The public URL is only for a checkout that has
// no remote at all (e.g. CI that exported GITHUB_REPOSITORY without adding one).
function resolveGitRemote(repo: string): string {
	try {
		if (runGit(['remote', 'get-url', 'origin'])) return 'origin';
	} catch {
		// No origin.
	}
	return `https://${GIT_PACKAGE_HOST}/${repo}.git`;
}

// A plain clone fetches refs/heads/* and refs/tags/* and nothing else, so those are the only
// namespaces a deployable ref can live in. A commit named through any other — refs/pull/<n>/head is
// the one people reach for — pins to a perfectly immutable SHA that the cluster then cannot check
// out, failing the clone exactly as the pull_request merge commit would. Rejecting the namespace
// catches that here, where the user can act on it, rather than on the cluster. It can't catch a bare
// SHA that happens to be unreachable: an object ID carries no namespace to inspect.
function assertCloneableRefNamespace(ref: string): void {
	if (!ref.startsWith('refs/') || ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) return;
	throw new Error(
		`deploy by_ref: ref=${ref} is outside refs/heads/ and refs/tags/, the only namespaces a clone ` +
			'fetches — the cluster could resolve that commit but never check it out. Pass a branch or tag the ' +
			'commit is on.'
	);
}

// `ls-remote` reports an annotated tag's peeled commit on a trailing `^{}` line — but only when a
// pattern matches that line, so the peel patterns have to be asked for explicitly. Without them a tag
// resolves to the *tag object's* ID, which is not a commit the cluster can check out. Every pattern is
// namespace-qualified: passing the bare `ref` as its own pattern would match any namespace ls-remote
// happens to serve, which is how an unreachable ref would slip through as a lone "unambiguous" match.
function resolveRefOnRemote(remote: string, ref: string): string | undefined {
	const qualified = ref.startsWith('refs/');
	const patterns = qualified ? [ref, `${ref}^{}`] : [`refs/tags/${ref}`, `refs/tags/${ref}^{}`, `refs/heads/${ref}`];
	let output: string;
	try {
		output = runGitNetwork(['ls-remote', remote, ...patterns]);
	} catch {
		return undefined; // unreachable, unauthenticated, or too slow to answer
	}
	const shaByRef = new Map<string, string>();
	for (const line of output.split('\n')) {
		const [sha, name] = line.split('\t');
		if (sha && name) shaByRef.set(name, sha);
	}
	// Peeled commit first (an annotated tag object isn't checkout-able), then tags over branches, which
	// is git's own precedence for a bare name (gitrevisions).
	if (qualified) return shaByRef.get(`${ref}^{}`) ?? shaByRef.get(ref);
	return shaByRef.get(`refs/tags/${ref}^{}`) ?? shaByRef.get(`refs/tags/${ref}`) ?? shaByRef.get(`refs/heads/${ref}`);
}

// An explicit ref= is pinned to an immutable SHA, exactly as HEAD is. Cluster peers resolve the
// package independently, so `ref=main` — or a tag repointed between one peer fetching and another
// re-fetching after a restart — would otherwise leave nodes running different commits. Resolution is
// local where possible (`^{commit}` also dereferences annotated tags), then falls back to the remote
// for a ref this checkout doesn't have (a shallow CI clone has almost none), and fails closed if
// neither can name a commit: a ref that can't be pinned is the divergence the pin exists to prevent.
function resolveExplicitRef(ref: string, repo: string): string {
	// git parses options anywhere in its argv, so a ref spelled like one (`--upload-pack=…`) would be
	// obeyed as an option instead of resolved. No real ref starts with `-` — git rejects those itself.
	if (ref.startsWith('-')) throw new Error(`deploy by_ref: invalid ref=${ref} — a git ref cannot start with "-".`);
	// Checked before local resolution, not just remote: a checkout that has fetched refs/pull/<n>/head
	// resolves it happily, and the resulting SHA is just as unreachable for the cluster's clone.
	assertCloneableRefNamespace(ref);
	try {
		return runGit(['rev-parse', '--verify', `${ref}^{commit}`]);
	} catch {
		// Not in this checkout — try the remote below.
	}
	if (FULL_OBJECT_ID.test(ref)) return ref; // already immutable; nothing to pin it to
	const remote = resolveGitRemote(repo);
	const resolved = resolveRefOnRemote(remote, ref);
	if (resolved) return resolved;
	throw new Error(
		`deploy by_ref: could not resolve ref=${ref} to a commit, locally or on ${remote}. Peers resolve the ` +
			'package independently, so a ref that moves would leave them on different commits — run `git fetch` ' +
			'and retry, or pass a full commit SHA.'
	);
}

// GitHub Actions checks out a *synthetic merge commit* on a `pull_request` run: GITHUB_SHA points at
// refs/pull/<n>/merge, which a plain clone never fetches (its default refspec covers refs/heads/* and
// refs/tags/* only), so deploying it fails server-side at clone time. The event payload carries the PR
// head — a real commit on a real branch — so deploy that instead, from the head repo, which for a fork
// isn't GITHUB_REPOSITORY. See the pull_request section of GitHub's events-that-trigger-workflows docs.
function resolveActionsPullRequestHead(): { repo: string; committish: string } | undefined {
	if (!/^refs\/pull\//.test(process.env.GITHUB_REF ?? '')) return undefined;
	const eventPath = process.env.GITHUB_EVENT_PATH;
	let head: any;
	try {
		if (eventPath) head = JSON.parse(fs.readFileSync(eventPath, 'utf8'))?.pull_request?.head;
	} catch {
		// Missing or unparseable payload — the error below is the useful outcome either way.
	}
	const committish = typeof head?.sha === 'string' ? head.sha : undefined;
	const repo = typeof head?.repo?.full_name === 'string' ? head.repo.full_name : undefined;
	if (!committish || !repo) {
		throw new Error(
			`deploy by_ref: GITHUB_SHA on a ${process.env.GITHUB_REF} run is a synthetic merge commit that a plain ` +
				'clone cannot fetch, and the pull request head could not be read from GITHUB_EVENT_PATH. Pass the ' +
				'head commit explicitly: ref=${{ github.event.pull_request.head.sha }}.'
		);
	}
	if (repo !== process.env.GITHUB_REPOSITORY) {
		process.stderr.write(`note: deploying the pull request head from ${repo}, not ${process.env.GITHUB_REPOSITORY}.\n`);
	}
	return { repo, committish };
}

// Repo and commit are resolved together because they aren't independent: on a pull_request run both
// come from the PR head, and pairing a head SHA with the base repo would name a commit that repo
// doesn't have.
function resolveGitTarget(ref: unknown): { repo: string; committish: string } {
	// `ref` reaches here as a raw string from buildRequest (see RAW_STRING_FIELDS), but a number is
	// still coerced rather than ignored — prepareDeployByRef is callable with a hand-built req.
	const refStr = typeof ref === 'string' || typeof ref === 'number' ? String(ref).trim() : '';
	if (refStr.length > 0) {
		const repo = resolveGitRepo();
		return { repo, committish: resolveExplicitRef(refStr, repo) };
	}
	const pullRequestHead = resolveActionsPullRequestHead();
	if (pullRequestHead) return pullRequestHead;
	const repo = resolveGitRepo();
	if (process.env.GITHUB_SHA) return { repo, committish: process.env.GITHUB_SHA };
	try {
		return { repo, committish: runGit(['rev-parse', 'HEAD']) };
	} catch {
		throw new Error('deploy by_ref: could not resolve HEAD — make at least one commit, or pass ref=<sha|tag>.');
	}
}

function warnIfWorkingTreeDirty(): void {
	try {
		if (runGit(['status', '--porcelain'])) {
			process.stderr.write(
				'warning: working tree has uncommitted changes — the cluster deploys the committed (and pushed) commit, so those changes are NOT included.\n'
			);
		}
	} catch {
		// Not a git repo; resolveGitTarget will surface a clearer error.
	}
}

// The likelier by_ref mistake isn't a dirty tree, it's committing and forgetting to push: the
// cluster clones from the remote, so the SHA simply isn't there and the deploy fails server-side,
// far from the CLI and with a much less obvious error. Checked against local remote-tracking refs,
// so it costs no network round-trip — at the price of a false warning when the local view is stale,
// which the message accounts for.
function warnIfCommitNotPushed(committish: string): void {
	try {
		if (!runGit(['branch', '-r', '--contains', committish])) {
			process.stderr.write(
				`warning: commit ${committish.slice(0, 7)} isn't on any remote branch — push it, or the cluster ` +
					"won't be able to clone it. (If you already pushed, run `git fetch` to refresh your remote refs.)\n"
			);
		}
	} catch {
		// Not a git repo, or a committish git can't resolve locally (a remote-only ref is expected
		// to be absent here) — nothing useful to say, and the deploy itself surfaces real errors.
	}
}

function defaultProjectName(projectPath: string): string {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
		if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name.replace(/^@[^/]+\//, '');
	} catch {
		// No/invalid package.json — fall back to the directory name.
	}
	return path.basename(projectPath);
}

// Must produce the same name as the server's `deriveGitSecretName` (secretOperations.ts), so the
// reference this attaches matches the row `harper deploy setup=true` sealed and a literal-token
// deploy would use: `deploy.<component>.git.<host>`. Rather than restate the host-normalization
// chain, this shares the server's own `normalizeGitHost` — a future host quirk added there then
// can't drift from what the CLI sends. (gitCredentialServer.ts pulls in only node builtins plus
// the error/logger utilities `bin/` already uses, so importing it costs the CLI nothing.)
function deriveGitSecretName(component: string, host: string): string {
	const hostPart = normalizeGitHost(host).replace(/[^\w.-]+/g, '_');
	const componentPart = String(component).replace(/[^\w.-]+/g, '_');
	return `deploy.${componentPart}.git.${hostPart}`;
}

// The credential only helps if it's for the host the package is cloned from: a `credential=gitlab.com`
// against a github.com package builds a valid-looking reference the clone never asks for, and the
// private deploy then fails as if nothing were configured. So the host comes from the package rather
// than the user — an explicit value is accepted only when it agrees (`credential=github.com` is the
// documented spelling), and rejected loudly rather than silently producing a mismatched pair.
function resolveCredentialHost(credential: unknown, packageHost: string): string | undefined {
	if (credential === undefined || credential === false || credential === '') return undefined;
	if (credential === true) return packageHost;
	const host = normalizeGitHost(String(credential));
	if (host !== packageHost) {
		throw new Error(
			`deploy by_ref: credential=${credential} doesn't match the package host ${packageHost} — the clone ` +
				`authenticates against ${packageHost}, so a credential for another host would never be used. Use ` +
				'credential=true.'
		);
	}
	return packageHost;
}

// Opt-in deploy-by-reference: resolve the pinned git ref (+ optional sealed credential) onto `req` —
// a `git+https` package pinned by SHA, plus a `credentials` reference when `credential=` is set.
// Exported for unit tests.
export function prepareDeployByRef(req: any): void {
	const { repo, committish } = resolveGitTarget(req.ref);
	warnIfWorkingTreeDirty();
	// Skipped under GITHUB_SHA: on the one GitHub event where the checked-out commit isn't on a
	// cloneable branch (pull_request), resolveGitTarget already substitutes the PR head, so what's
	// left is pushed by construction — and a shallow/detached runner checkout has no remote-tracking
	// branches to check it against anyway.
	if (!process.env.GITHUB_SHA) warnIfCommitNotPushed(committish);
	if (!req.project) req.project = defaultProjectName(process.cwd());
	// git+https (not ssh): a private clone is authenticated by a git-host token credential (#1799),
	// which rides over HTTPS. A public repo needs no credential at all.
	req.package = `git+https://${GIT_PACKAGE_HOST}/${repo}.git#${committish}`;
	// `credential=true` attaches the sealed-token reference the cluster resolves at fetch time —
	// provision it once with `harper deploy setup=true`.
	const credentialHost = resolveCredentialHost(req.credential, GIT_PACKAGE_HOST);
	if (credentialHost && req.credentials === undefined) {
		req.credentials = [{ host: credentialHost, secret: deriveGitSecretName(req.project, credentialHost) }];
	}
	process.stderr.write(`Deploying "${req.project}" by reference: ${req.package}\n`);
}

const PREPARE_OPERATION: any = {
	deploy_component: async (req) => {
		if (req.package) {
			return;
		}

		// Opt-in: deploy a pinned git commit by reference instead of packaging the working directory.
		// Templates scaffold `by_ref=true`; without the flag the payload path below is unchanged.
		if (req.by_ref || req.ref) {
			prepareDeployByRef(req);
			return;
		}

		const projectPath = process.cwd();
		if (!req.project) req.project = path.basename(projectPath);
		const packageOptions = {
			skip_node_modules: req.skip_node_modules !== false,
			skip_symlinks: req.skip_symlinks === true,
		};
		// Store path + options for deferred stream creation after the renderer is set up,
		// so the pre-gzip onBytes callback can be wired directly to renderer.countUploadBytes.
		req._projectPath = projectPath;
		req._packageOptions = packageOptions;
		// Pre-walk the directory once for both the uncompressed-size estimate (progress bar
		// total) and the dangling-symlink list — a dangling symlink would otherwise silently
		// truncate the tarball (tar-fs finalizes early on the broken target). Packaging skips
		// them; the list is reused below (no second walk) and warns the user which links were
		// skipped so the omission is visible.
		const scan = await scanPackageDirectory(projectPath, packageOptions);
		req._uploadSizeEstimate = scan.totalSize;
		req._danglingSymlinks = scan.danglingSymlinks;
		if (scan.danglingSymlinks.length) {
			process.stderr.write(
				`warning: skipping ${scan.danglingSymlinks.length} broken symlink(s) — their linked content will NOT be deployed:\n` +
					scan.danglingSymlinks.map((p) => `  ${p}\n`).join('')
			);
		}
		req._multipart = true;
	},
};

/**
 * Builds an Op-API request object from CLI args
 */
function buildRequest(): any {
	const req: any = {};
	for (const arg of process.argv.slice(2)) {
		if (OP_ALIASES.hasOwnProperty(arg)) {
			req.operation = OP_ALIASES[arg];
		} else if (arg.includes('=')) {
			let [first, ...rest] = arg.split('=');
			let restStr: any = rest.join('=');

			if (!RAW_STRING_FIELDS.has(first)) {
				try {
					restStr = JSON.parse(restStr);
				} catch {
					/* noop */
				}
			}

			req[first] = restStr;
		} else {
			// operation should only be in the first arg
			req.operation ??= arg;
		}
	}

	return req;
}

/**
 * Resolves the target URL from various sources.
 * @param {Object} req The request object.
 * @param {Object} allCredentials Stored credentials.
 * @returns {string|null} The resolved target URL.
 */
function resolveTarget(req, allCredentials) {
	return (
		req.target ||
		process.env.HARPER_CLI_TARGET ||
		process.env.CLI_TARGET ||
		(allCredentials && allCredentials.last_target)
	);
}

/**
 * Ensures `tokens.operation_token` is usable, minting a fresh one via `refresh_operation_token`
 * when it is expired — or absent entirely, which is the refresh-token-only shape a CI/CD runner
 * gets from `HARPER_CLI_REFRESH_TOKEN`. Updates `tokens.operation_token` in place.
 *
 * `persistKey` is the credentials-file key to write the refreshed token back to; pass `null` for
 * tokens sourced from env vars, which have no file entry and stay in memory for this invocation
 * only. Shared by `cliOperations` and any other CLI transport (e.g. `harper agent`) authenticating
 * with tokens, so refresh behavior stays in one place instead of drifting between callers.
 */
async function refreshExpiredOperationToken(
	options: any,
	tokens: { operation_token?: string; refresh_token?: string },
	persistKey: string | null
): Promise<void> {
	if (!tokens.refresh_token) return;
	// Short-circuited so `isJWTExpired` never runs on an absent token.
	if (tokens.operation_token && !isJWTExpired(tokens.operation_token)) return;
	console.error(
		tokens.operation_token
			? 'Operation token expired, attempting to refresh...'
			: 'Minting an operation token from the refresh token...'
	);
	try {
		// Always use the standard operation timeout for this call, even when the caller's
		// own options carry the longer SSE timeout (e.g. a deploy_component retry) — the
		// refresh call itself is a small, fast request, not the streaming operation.
		const refreshOptions = { ...options, timeout: CLI_OPERATION_TIMEOUT_MS };
		refreshOptions.headers = { ...options.headers, Authorization: `Bearer ${tokens.refresh_token}` };
		const refreshResponse = await httpRequest(refreshOptions, {
			operation: 'refresh_operation_token',
		});
		if (refreshResponse.statusCode === 200) {
			const refreshData = JSON.parse(refreshResponse.body);
			if (refreshData.operation_token) {
				tokens.operation_token = refreshData.operation_token;
				// Only file-based credentials are persisted; env-var tokens have no file entry.
				if (persistKey) {
					saveCredentials(persistKey, {
						operation_token: tokens.operation_token,
						refresh_token: tokens.refresh_token,
					});
				}
				console.error('Operation token refreshed successfully.');
			}
		} else if (refreshResponse.statusCode === 401) {
			console.error('Refresh token expired or invalid. Please run harper login again.');
			process.exit(1);
		} else {
			console.error(`Failed to refresh operation token: ${refreshResponse.statusCode}`);
		}
	} catch (refreshErr) {
		console.error(`Error refreshing operation token: ${refreshErr.message}`);
	}
}

/**
 * Using a unix domain socket will send a request to hdb operations API server
 * @param req
 * @param skipResponseLog By default, the response is logged to the console. Set this to true to skip logging it, which can be useful for sensitive responses like login calls!
 * @returns {Promise<void>}
 */
/**
 * Resolve the transport options for a CLI operation request: a remote target URL (with auth) when
 * one is configured (`target=`, env, or a saved `last_target`), otherwise the local domain socket.
 * Returns the `options` object ready for `httpRequest` (method + Content-Type, and an Authorization
 * header for remote targets, refreshing an expired operation token when possible) plus the resolved
 * `target` (undefined for a local connection). Exits the process if a local connection is required
 * but Harper is not running or has no domain socket. Shared by `cliOperations` and the CLI's
 * streaming `get_backup` download so both reach local and remote servers the same way.
 */
export async function resolveRequestOptions(req: any): Promise<{ options: any; target: any }> {
	const allCredentials = loadCredentials();
	const rawTarget = resolveTarget(req, allCredentials);
	// Userinfo is a transport credential, and `normalizeTarget` strips it so the resolved target can
	// be logged, stored and emitted freely — so read it off the raw value first.
	const urlCredentials = extractTargetCredentials(rawTarget);
	req.target = normalizeTarget(rawTarget);
	let target;
	if (req.target) {
		let parsedTarget;
		try {
			parsedTarget = new URL(req.target);
		} catch (error) {
			try {
				parsedTarget = new URL(`https://${req.target}:9925`);
			} catch {
				throw error;
			}
		}
		const resolvedTarget = req.target;
		target = {
			protocol: parsedTarget.protocol,
			hostname: parsedTarget.hostname,
			port: parsedTarget.port,
			rejectUnauthorized: req.rejectUnauthorized,
			resolvedTarget,
		};
		console.error(`Connecting to ${redactTargetUrl(resolvedTarget)}`);
	} else {
		// if we aren't doing a targeted operation (like deploy), we initialize the config and verify that local harper
		// is running and that we can communicate with it.
		console.error('Connecting to local Harper instance');
		initConfig();
		if (!getHdbPid()) {
			console.error(LOCAL_NOT_RUNNING_MESSAGE);
			process.exit(1);
		}

		if (!fs.existsSync(getConfigPath(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET))) {
			console.error(LOCAL_NOT_RUNNING_MESSAGE);
			process.exit(1);
		}
	}
	let options = target ?? {
		protocol: 'http:',
		socketPath: getConfigPath(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET),
	};
	options.method = 'POST';
	options.headers = { 'Content-Type': 'application/json' };
	options.timeout = SSE_OPERATIONS.has(req.operation) ? SSE_OPERATION_TIMEOUT_MS : CLI_OPERATION_TIMEOUT_MS;
	// Authentication precedence: explicitly configured credentials (dedicated args, URL
	// userinfo, env vars) beat everything, then env-var tokens, then the saved `harper login`
	// token, and only then the legacy `username=`/`password=` payload fallback below. The
	// tokens must outrank that fallback: for add_user/alter_user those args are the credentials
	// of the user being created/altered, so treating them as auth would authenticate as a user
	// who doesn't exist yet (or as the wrong identity) instead of using the admin's session.
	const transportCredentials = target ? resolveTransportCredentials(req, urlCredentials) : undefined;
	if (transportCredentials) {
		options.headers.Authorization = basicAuthHeader(transportCredentials.username, transportCredentials.password);
	} else if (target) {
		// Bearer-token auth, for remote targets ONLY. A local operation goes over the domain
		// socket, which the server trusts via `bypassLocalAuth` — but that bypass is an
		// `else if` on "no Authorization header present" (security/auth.ts), so attaching a
		// Bearer token to a local request opts out of the trust and gets validated instead,
		// 401ing on a token minted for some other cluster. Since these env vars are meant to
		// persist across a whole CI job (or a developer's shell), an ungated read here would
		// break every local `harper` command run in that environment.
		//
		// Env-var tokens (for CI/CD — see `harper login --for-ci`) take precedence over the
		// stored ~/.harperdb/credentials.json entry: they're an explicit per-invocation override
		// that needs no prior `harper login` on the runner. A token refreshed from env vars is
		// used in-memory only (there's no file to write back to); a token refreshed from the
		// credentials file is persisted as before.
		//
		// Whichever namespace supplies a token owns both halves. Resolving them independently
		// would let `HARPER_CLI_OPERATION_TOKEN` from one user pair with
		// `CLI_TARGET_REFRESH_TOKEN` from another: commands would run as the first identity
		// until its operation token expired, then silently continue as the second. `login.ts`
		// selects its username/password namespace as a unit for exactly this reason.
		const tokenPrefix = ['HARPER_CLI', 'CLI_TARGET'].find(
			(prefix) =>
				process.env[`${prefix}_OPERATION_TOKEN`] !== undefined || process.env[`${prefix}_REFRESH_TOKEN`] !== undefined
		);
		const envOperationToken = tokenPrefix ? process.env[`${tokenPrefix}_OPERATION_TOKEN`]?.trim() : undefined;
		const envRefreshToken = tokenPrefix ? process.env[`${tokenPrefix}_REFRESH_TOKEN`]?.trim() : undefined;
		// A namespace that is set but blank is a broken CI secret, not a request to fall back to
		// whatever the developer last logged in as — say so rather than switching identity silently.
		if (tokenPrefix && !envOperationToken && !envRefreshToken) {
			console.error(
				`Ignoring empty ${tokenPrefix}_OPERATION_TOKEN/${tokenPrefix}_REFRESH_TOKEN; falling back to saved login credentials.`
			);
		}

		let tokens: { operation_token?: string; refresh_token?: string } | null = null;
		let persistKey: string | null = null; // non-null => persist a refreshed operation token back to the file
		if (envOperationToken || envRefreshToken) {
			tokens = { operation_token: envOperationToken, refresh_token: envRefreshToken };
		} else if (allCredentials?.targets) {
			persistKey = target.resolvedTarget;
			tokens = allCredentials.targets[persistKey] ?? null;
		}

		if (tokens?.operation_token || tokens?.refresh_token) {
			await refreshExpiredOperationToken(options, tokens, persistKey);
			if (tokens.operation_token) {
				options.headers.Authorization = `Bearer ${tokens.operation_token}`;
			}
		}
	}
	// Legacy fallback for operations where `username=`/`password=` genuinely ARE the caller's
	// credentials (e.g. `create_table username= password=`) and nothing else is configured.
	// Both are required — a lone `username=` (as in `drop_user username=bob`) is payload, not
	// a credential.
	if (target && !options.headers.Authorization && req.username && req.password) {
		options.headers.Authorization = basicAuthHeader(req.username, req.password);
	}
	return { options, target };
}

async function cliOperations(req: any, skipResponseLog = false) {
	require('dotenv').config();

	// Resolve target/auth inside the try so a credential or connection error (e.g. an incomplete
	// `auth_username=`/`auth_password=` pair, which resolveRequestOptions throws on) is mapped to the
	// same console.error + process.exit(1) as every other failure below, rather than escaping as an
	// unhandled rejection. `target` is declared out here so the catch can still reference it.
	let options: any, target: any;
	try {
		({ options, target } = await resolveRequestOptions(req));
		await PREPARE_OPERATION[req.operation]?.(req);
		// Streaming deploy (multipart upload + SSE progress) only works against >= 5.1 servers.
		// When deploying to a remote target, probe its version first and downgrade to the
		// legacy JSON deploy if it predates 5.1. Local (domain-socket) deploys always
		// hit this same Harper build, so no probe is needed there.
		if (req.operation === 'deploy_component' && target && !(await targetSupportsStreamingDeploy(options))) {
			req._legacyDeploy = true;
			if (req._multipart) {
				// Re-package the directory as a single buffered tarball. The legacy CBOR body
				// below carries it as native binary, matching the pre-5.1 CLI. Wrap the
				// packaging so a local failure (e.g. a file vanishing after the size walk)
				// surfaces as itself rather than being mapped to "Failed to connect to Harper"
				// by the catch below (which keys off err.code === 'ENOENT').
				try {
					req.payload = await packageDirectory(req._projectPath, req._packageOptions);
				} catch (packageErr: any) {
					throw new Error(`Failed to package component directory '${req._projectPath}': ${packageErr.message}`, {
						cause: packageErr,
					});
				}
				delete req._multipart;
			}
			console.error(
				'Target Harper predates streaming deploy (< 5.1); using legacy compatibility deploy (no live progress).'
			);
		}

		const useSse = SSE_OPERATIONS.has(req.operation) && !req._legacyDeploy;
		if (useSse) {
			options.headers.Accept = 'text/event-stream';
			options.streamResponse = true;
		}
		// One renderer owns the (future) upload bar and the SSE event rendering for a
		// multipart deploy. Created here so the upload-stream tap and the SSE consumer
		// below share the same instance.
		const renderer = req._multipart ? new DeployRenderer({ uploadTotal: req._uploadSizeEstimate ?? 0 }) : null;
		let body;
		if (req._multipart) {
			// Create the package stream here — after the renderer exists — so we can pass
			// renderer.countUploadBytes as the onBytes callback. Both progress and total are
			// uncompressed bytes, so the bar tracks accurately to 100% without premature snapping.
			const packageStream = streamPackagedDirectory(
				req._projectPath,
				req._packageOptions,
				renderer ? (n) => renderer.countUploadBytes(n) : undefined,
				req._danglingSymlinks
			);
			const fields = operationFields(req);
			const multipart = buildMultipartBody(fields, {
				name: 'payload',
				filename: 'package.tar.gz',
				contentType: 'application/gzip',
				stream: Readable.from(wrapPackagingStream(packageStream, req._projectPath)),
			});
			options.headers['Content-Type'] = multipart.contentType;
			// Use chunked transfer-encoding: we don't know the total size up front because the
			// payload is streamed from `tar.pack` and never fully buffered.
			options.headers['Transfer-Encoding'] = 'chunked';
			// Tap the body so bytes flowing into the HTTP request advance the upload bar.
			// The renderer's Transform is identity — chunks pass through unmodified.
			body = renderer ? renderer.tapUploadStream(multipart.stream) : multipart.stream;
		} else if (req._legacyDeploy) {
			const fields = operationFields(req);
			if (Buffer.isBuffer(fields.payload)) {
				// Directory deploy: CBOR-encode so the tarball travels as a native binary
				// byte string (the pre-5.1 transport). The pre-5.1 server's cbor parser hands
				// the handler a real Buffer payload. Accept JSON so the buffered response
				// parses on the existing (non-SSE) path below.
				options.headers['Content-Type'] = 'application/cbor';
				options.headers.Accept = 'application/json';
				body = encodeCbor(fields);
			} else {
				// Package deploy (no binary payload): plain JSON, as pre-5.1 sent it.
				body = fields;
			}
		} else {
			// Same TRANSPORT_ONLY_FIELDS stripping as the deploy body paths above — auth_username/
			// auth_password (and target/rejectUnauthorized/json/etc.) must never reach the wire as
			// operation-payload fields, on this path either.
			body = operationFields(req);
		}
		let response: any = await httpRequest(options, body);

		// endUpload() is called from the counter Transform's flush callback in tapUploadStream
		// once all multipart bytes have flowed through. For SSE deploys, httpRequest resolves
		// when response headers arrive (streamResponse: true), which happens before the full
		// upload completes — calling endUpload() here would snap the bar prematurely.

		let responseData;
		if (useSse && response.headers['content-type']?.startsWith('text/event-stream')) {
			// Consume SSE: render phase events live, capture the final result from the `done`
			// event (or the error message from the `error` event). The HTTP status stays 200
			// until end-of-stream; failures are signaled in-band.
			let finalResult;
			let sseError;
			for await (const message of parseSSE(response)) {
				renderer?.renderEvent(message);
				if (message.event === 'done') {
					try {
						finalResult = JSON.parse(message.data)?.result;
					} catch {
						finalResult = message.data;
					}
				} else if (message.event === 'error') {
					try {
						sseError = JSON.parse(message.data);
					} catch {
						sseError = { message: message.data };
					}
				}
			}
			if (sseError) {
				const errMsg = sseError.message ?? (typeof sseError === 'object' ? JSON.stringify(sseError) : sseError);
				console.error(`error: ${errMsg}`);
				process.exit(1);
			}
			responseData = finalResult ?? { message: 'Deploy completed (no result payload).' };
		} else {
			// When useSse is true, httpRequest returns a raw IncomingMessage (streamResponse mode),
			// so .body is undefined. Drain the stream to get the text (e.g. a 401 error body).
			let bodyText: string;
			if (useSse) {
				const chunks: Buffer[] = [];
				for await (const chunk of response as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
				bodyText = Buffer.concat(chunks).toString('utf8');
			} else {
				bodyText = response.body;
			}
			try {
				responseData = JSON.parse(bodyText);
			} catch {
				responseData = {
					status: response.statusCode + ' ' + (response.statusMessage || 'Unknown'),
					body: bodyText,
				};
			}
		}

		let responseLog;
		if (req.json) {
			responseLog = JSON.stringify(responseData, null, 2);
		} else {
			responseLog = YAML.stringify(responseData).trim();
		}

		const { statusCode } = response;
		if (statusCode < 200 || (statusCode >= 300 && statusCode !== 304)) {
			const errorPrefix = responseLog.startsWith('error:') ? '' : 'error: ';
			console.error(`${errorPrefix}${responseLog}`);
			process.exit(1);
		}

		if (!skipResponseLog) {
			console.log(responseLog);
		}

		if (target) {
			responseData.resolvedTarget = target.resolvedTarget;
		}

		return responseData;
	} catch (err) {
		let code, message, hostname;
		try {
			code = err?.code;
			message = err?.message;
			hostname = err?.hostname;
		} catch {}
		const isConnectionFailure = code === 'ENOENT' || code === 'ECONNREFUSED';
		if (isConnectionFailure && !target) {
			console.error(LOCAL_NOT_RUNNING_MESSAGE);
		} else if (isConnectionFailure) {
			console.error(`error: Failed to connect to Harper (${code}): ${message}`);
		} else if (code === 'EACCES') {
			console.error(`error: Permission denied accessing the domain socket: ${message}`);
		} else if (code === 'ENOTFOUND') {
			console.error(`error: Host not found: "${hostname}" ${message}`);
		} else {
			console.error(`error: ${message ?? err}`);
		}
		process.exit(1);
	}
}
