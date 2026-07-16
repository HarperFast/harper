// Per-deploy git credential channel for private git-reference deploys (#1792).
//
// npm shells out to git to resolve a `github:org/repo#semver:...` package, and a private repo makes
// that clone need a credential. Every obvious way to hand git one persists it: a URL with embedded
// userinfo lands in the package spec and the lockfile, a `credential.helper` or an `.npmrc` is a
// file, and an env var is readable by every descendant process.
//
// Instead the token stays in this process's memory and is served over a per-deploy Unix socket in a
// 0700 directory. git is pointed at gitCredentialHelper.js — a secret-free script that relays git's
// request over that socket — and the socket dies with the spawn that needed it. The token never
// reaches disk, argv, the package spec, the operation body, or the operations log.

import { createServer, type Server, type Socket } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientError } from '../utility/errors/hdbError.ts';
import logger from '../utility/logging/harper_logger.ts';

// GitHub's convention for authenticating a PAT over HTTPS: any non-empty username works, and
// `x-access-token` is what its own tooling sends. GitLab wants `oauth2` and Bitbucket
// `x-token-auth`, so a credential entry can override it.
export const DEFAULT_GIT_USERNAME = 'x-access-token';

// The one variable that carries authority: without it gitCredentialHelper.js cannot reach a session
// and answers nothing, so stripping it from a spawn's environment fully disarms the helper even if
// GIT_ASKPASS/GIT_CONFIG_* were somehow inherited.
export const GIT_CREDENTIAL_SOCKET_ENV = 'HARPER_GIT_CREDENTIAL_SOCKET';

// Generous for git's key=value request (a few hundred bytes), small enough that a peer streaming
// junk cannot exhaust the heap.
const MAX_REQUEST_BYTES = 64 * 1024;

/** A git-host credential after resolution: a literal token, held in memory for one deploy. */
export interface ResolvedGitCredential {
	host: string;
	token: string;
	username?: string;
}

export interface GitCredentialSession {
	/** Environment to merge into the spawn that performs the git clone — and only that spawn. */
	env: Record<string, string>;
	close(): Promise<void>;
}

/** `https://github.com/` / `GitHub.com` / `github.com/` all identify the same host. */
export function normalizeGitHost(host: string): string {
	return host
		.trim()
		.replace(/^[a-z0-9+.-]+:\/\//i, '')
		.replace(/^\/\//, '')
		.replace(/\/.*$/, '')
		.replace(/^[^@]*@/, '')
		.toLowerCase();
}

// A loopback remote never puts the credential on a network, so plaintext http to one is not a
// disclosure. Anything else must be encrypted.
function isLoopbackHost(host: string): boolean {
	const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function answerFor(credentials: Map<string, ResolvedGitCredential>, request: any) {
	if (!request || typeof request !== 'object') return {};
	const host = typeof request.host === 'string' ? normalizeGitHost(request.host) : '';
	const credential = credentials.get(host);
	// An unknown host is not an error: git also asks about public hosts, and answering nothing lets
	// it proceed unauthenticated rather than failing the deploy.
	if (!credential) return {};
	// Never hand a token to a cleartext transport. git asks for `http://` credentials exactly as it
	// asks for `https://` ones, so without this a `git+http://` package (or a remote downgraded by a
	// redirect) would put the token on the wire in the clear.
	const protocol = typeof request.protocol === 'string' ? request.protocol.toLowerCase() : '';
	if (protocol && protocol !== 'https' && !isLoopbackHost(host)) {
		logger.warn?.(`refusing to serve a git credential for '${host}' over ${protocol}: only https is allowed`);
		return {};
	}
	// git's credential protocol is line-based (and askpass reads only the first line), so a token
	// carrying a newline would be truncated or would inject protocol attributes. A literal token is
	// already rejected by the op schema; one resolved from an hdb_secret row is not, so guard the
	// write boundary — the same place the .npmrc writer guards (#1717).
	if (/[\r\n\0]/.test(credential.token)) {
		logger.warn?.(`git credential for '${host}' contains an illegal control character; refusing to serve it`);
		return {};
	}
	// git only re-asks with a username once it has one; if it names a different user than the one
	// this credential is for, the credential does not apply.
	const username = credential.username ?? DEFAULT_GIT_USERNAME;
	if (typeof request.username === 'string' && request.username && request.username !== username) return {};
	return { username, password: credential.token };
}

// The `credential.helper` reset below only takes effect on git >= 2.31, where GIT_CONFIG_* is
// honored; older git ignores those variables entirely and would fall through to GIT_ASKPASS with an
// inherited helper chain still live — so a machine configured with `credential.helper=store` would
// write this token to ~/.git-credentials. There is no way to disable an inherited helper on those
// versions, so refuse to serve a credential at all rather than persist one behind the operator's back.
const MINIMUM_GIT_VERSION = [2, 31];
function assertGitSupportsConfigEnv(): void {
	let version: string;
	try {
		version = execFileSync('git', ['--version'], { encoding: 'utf8' });
	} catch (error) {
		throw new ClientError(`git is required to deploy from a git reference, but could not be run: ${error}`);
	}
	const parsed = /(\d+)\.(\d+)/.exec(version);
	if (!parsed) throw new ClientError(`Could not determine the git version from '${version.trim()}'`);
	const [major, minor] = [Number(parsed[1]), Number(parsed[2])];
	if (major < MINIMUM_GIT_VERSION[0] || (major === MINIMUM_GIT_VERSION[0] && minor < MINIMUM_GIT_VERSION[1])) {
		throw new ClientError(
			`git ${MINIMUM_GIT_VERSION.join('.')} or newer is required to deploy with a git-host credential ` +
				`(found ${version.trim()}): older versions ignore GIT_CONFIG_*, so an inherited credential helper ` +
				`could persist the token to disk.`
		);
	}
}

/**
 * Start a credential session for one deploy. Returns the environment that lets git reach it, which
 * the caller must apply ONLY to the spawn doing the clone (`npm pack`), never to the `npm install`
 * that follows — a transitive dependency's install script must not be able to ask for a credential
 * that was granted for the top-level repository.
 *
 * Wiring, in order of preference:
 *   - `credential.helper` via GIT_CONFIG_* (git >= 2.31). Structured key=value protocol, no prompt
 *     parsing. Inherited helpers are reset to empty first, so a machine configured with
 *     `credential.helper=store` cannot write this token to ~/.git-credentials when git reports the
 *     successful authentication back to its helper chain.
 *   - GIT_ASKPASS, honored by every git version, as the fallback for git < 2.31 (where GIT_CONFIG_*
 *     is silently ignored). npm's own git wrapper sets `GIT_ASKPASS=echo`, but only when the
 *     variable is unset, so ours survives.
 * GIT_TERMINAL_PROMPT=0 keeps git from falling back to a terminal prompt (which would hang a deploy
 * rather than fail it) if neither path yields a credential.
 */
export async function startGitCredentialSession(
	credentials: ResolvedGitCredential[],
	helperPath: string
): Promise<GitCredentialSession> {
	const byHost = new Map<string, ResolvedGitCredential>();
	for (const credential of credentials) {
		const host = normalizeGitHost(credential.host);
		// Two entries for the same host in one deploy is operator error — the second silently wins here
		// (and its sealed secret already overwrote the first's, sharing a derived name). Surface it.
		if (byHost.has(host)) logger.warn?.(`multiple git credentials supplied for host '${host}'; using the last`);
		byHost.set(host, credential);
	}

	// The credential's confinement rests on filesystem permissions: a 0700 directory means only this
	// uid can reach the socket. A Windows named pipe has no equivalent guarantee — it is created with
	// a default security descriptor that can leave it open to other local users, which would hand the
	// token to any process on the box. Rather than offer a quietly weaker credential channel, fail
	// closed and let the operator use a deploy path whose isolation we can actually state.
	if (process.platform === 'win32') {
		throw new ClientError(
			'git-host deploy credentials are not supported on Windows: the credential is served over a Unix ' +
				'domain socket, which has no Windows equivalent that can be confined to this process owner.'
		);
	}
	// Fail before minting a socket if git is too old for the credential-helper reset to hold.
	assertGitSupportsConfigEnv();
	// mkdtemp creates the directory 0700, so only this uid can reach the socket inside it.
	const socketDir = await mkdtemp(join(tmpdir(), 'harper-git-cred-'));
	const socketPath = join(socketDir, 'credential.sock');

	const connections = new Set<Socket>();
	// allowHalfOpen: the helper half-closes after sending its request, and we must still be able to
	// write the answer back.
	const server: Server = createServer({ allowHalfOpen: true }, (connection) => {
		connections.add(connection);
		connection.on('close', () => connections.delete(connection));
		// A helper that dies mid-request must not take the node down with an unhandled 'error'.
		connection.on('error', (error) => logger.warn?.(`git credential connection failed: ${error.message}`));
		connection.setEncoding('utf8');
		let request = '';
		connection.on('data', (chunk) => {
			request += chunk;
			// A real request is a few hundred bytes. Cap it so a peer that streams without ever closing
			// cannot grow this buffer until the node runs out of heap.
			if (request.length > MAX_REQUEST_BYTES) {
				logger.warn?.('git credential request exceeded the maximum size; dropping the connection');
				connection.destroy();
			}
		});
		connection.on('end', () => {
			let answer: object;
			try {
				answer = answerFor(byHost, JSON.parse(request));
			} catch {
				answer = {};
			}
			connection.end(JSON.stringify(answer));
		});
	});
	server.on('error', (error) => logger.warn?.(`git credential server failed: ${error.message}`));

	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(socketPath, () => {
				server.removeListener('error', reject);
				resolve();
			});
		});
	} catch (error) {
		// listen() failed, so no session is returned and nothing will call close() — take the temp dir
		// with us rather than leaving a 0700 directory behind on every failed deploy.
		await rm(socketDir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}

	// Quoted so a Harper installed under a path with spaces still works: git runs both the askpass
	// command and a `!`-prefixed credential helper through a shell.
	const helperCommand = `"${process.execPath}" "${helperPath}"`;
	// Append to any GIT_CONFIG_* the operator already set rather than overwriting theirs; ours come
	// last, which is also where git takes precedence from.
	const inheritedCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '', 10);
	const base = Number.isInteger(inheritedCount) && inheritedCount > 0 ? inheritedCount : 0;
	const env: Record<string, string> = {
		[GIT_CREDENTIAL_SOCKET_ENV]: socketPath,
		GIT_TERMINAL_PROMPT: '0',
		GIT_ASKPASS: helperCommand,
		GIT_CONFIG_COUNT: String(base + 2),
		// An empty value resets git's credential helper list, dropping any inherited helper.
		[`GIT_CONFIG_KEY_${base}`]: 'credential.helper',
		[`GIT_CONFIG_VALUE_${base}`]: '',
		[`GIT_CONFIG_KEY_${base + 1}`]: 'credential.helper',
		[`GIT_CONFIG_VALUE_${base + 1}`]: `!${helperCommand}`,
	};

	return {
		env,
		async close() {
			byHost.clear();
			// destroy() synchronously fires each connection's 'close' listener, which deletes it from this
			// same Set — iterate a snapshot so that mid-iteration mutation cannot skip a connection.
			const connectionsSnapshot = Array.from(connections);
			for (const connection of connectionsSnapshot) connection.destroy();
			connections.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			try {
				await rm(socketDir, { recursive: true, force: true });
			} catch (error) {
				// Called from a finally; a throw here would mask the deploy's own error.
				logger.warn?.(`Failed to remove git credential socket dir ${socketDir}: ${(error as Error).message}`);
			}
		},
	};
}
