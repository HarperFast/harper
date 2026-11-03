import dotenv from 'dotenv';
import { getHomeDir } from '../utility/common_utils.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import fs from 'node:fs';
import path from 'node:path';

const ownerRWDenyAllOthers = 0o600;

interface TargetedCredentials {
	last_target: string | null;
	targets: {
		[target: string]: Tokens;
	};
}

interface Tokens {
	operation_token: string;
	refresh_token: string;
}

function withScheme(target: string): string {
	return target.startsWith('http://') || target.startsWith('https://') ? target : 'https://' + target;
}

/**
 * Reads the userinfo out of a raw, pre-normalization target URL. `normalizeTarget` strips it, so a
 * caller that authenticates with `https://user:password@host` has to take it from the raw string
 * before normalizing. Absent userinfo yields empty strings.
 */
export function extractTargetCredentials(target: string): { username: string; password: string } {
	if (target) {
		try {
			const url = new URL(withScheme(target));
			return { username: url.username, password: url.password };
		} catch {
			// Not a valid URL — there is no userinfo to extract, and the target itself will fail later.
		}
	}
	return { username: '', password: '' };
}

/**
 * Normalizes a target operations API URL to a canonical form (with trailing slash), free of any
 * embedded credentials.
 *
 * A normalized target is an identity, not a credential: it keys ~/.harperdb/credentials.json, is
 * echoed by the "Connecting to ..." line, and emitted by `harper login --for-ci`.
 * Userinfo riding along would put the password in all three, so it is dropped here rather than at
 * each of those sites — use `extractTargetCredentials` to read it for transport authentication.
 */
export function normalizeTarget(target: string): string {
	if (!target) return target;
	let normalized = withScheme(target);
	try {
		const url = new URL(normalized);
		// Whether a port was written out explicitly. `url.port` is empty for a default port
		// (`https://host:443`), hence the fallback to the raw authority — with any `user:password`
		// removed first, since that colon is userinfo, not a port.
		const authority = normalized.slice(normalized.indexOf('://') + 3).split(/[/?#]/)[0];
		const hasExplicitPort = !!url.port || authority.slice(authority.lastIndexOf('@') + 1).includes(':');
		url.username = '';
		url.password = '';
		if (!hasExplicitPort) url.port = '9925';
		normalized = url.toString();
		// `URL` serializes a default port away, so `https://host:443` would come back port-less and a
		// second pass — login normalizes, then cliOperations normalizes again — would read that as
		// "no port given" and append 9925, silently retargeting. Writing the port back keeps this
		// idempotent, which every caller assumes since the output is also the credentials-file key.
		if (hasExplicitPort && !url.port) {
			const defaultPort = url.protocol === 'https:' ? '443' : '80';
			normalized = normalized.replace(`//${url.host}`, `//${url.host}:${defaultPort}`);
		}
	} catch {
		// If it's not a valid URL yet, we'll let it be handled later or it will fail
	}
	if (!normalized.endsWith('/')) {
		normalized += '/';
	}
	return normalized;
}

/**
 * Environment names that choose where a CLI command connects, which credential it sends or which
 * saved login it reads, whether the connection is verified, or which repository deploy setup trusts.
 * Upper case: Windows environment names are case-insensitive, and Node reads lowercase proxy names too.
 */
const CLI_TRUST_ENV_KEYS = new Set([
	'HARPER_CLI_TARGET',
	'CLI_TARGET',
	...['HARPER_CLI', 'CLI_TARGET'].flatMap((prefix) =>
		['USERNAME', 'PASSWORD', 'OPERATION_TOKEN', 'REFRESH_TOKEN'].map((suffix) => `${prefix}_${suffix}`)
	),
	'ACTIONS_ID_TOKEN_REQUEST_URL',
	'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
	'GITHUB_REPOSITORY',
	'HOME',
	'USERPROFILE',
	'NODE_TLS_REJECT_UNAUTHORIZED',
	'NODE_USE_ENV_PROXY',
	'HTTP_PROXY',
	'HTTPS_PROXY',
]);

/**
 * Loads the current directory's `.env` (or `.env.vault`) into `process.env` the way `dotenv.config()`
 * does, never overriding an inherited value, but first refuses the whole file if it would supply a
 * `CLI_TRUST_ENV_KEYS` value. The working directory is often a cloned project, so it must not decide
 * where credentials go; ignoring those keys instead would silently fall back to the saved login target
 * or, for backup commands, to local files.
 */
export function loadCliDotenv(): void {
	const staged: Record<string, string> = {};
	dotenv.config({ processEnv: staged, quiet: true });
	const refused = Object.keys(staged).filter(
		(key) => CLI_TRUST_ENV_KEYS.has(key.toUpperCase()) && !Object.prototype.hasOwnProperty.call(process.env, key)
	);
	if (refused.length > 0) {
		const them = refused.length === 1 ? 'it' : 'them';
		throw new ClientError(
			`${refused.join(', ')} must not come from the .env file in ${process.cwd()}: a project's .env no longer ` +
				`sets the Harper CLI's target, credentials or connection settings (earlier 'harper login' versions ` +
				`added HARPER_CLI_TARGET there). Remove ${them} from that file, then set ${them} in your shell or CI ` +
				`environment, pass target=<url>, or rely on the target 'harper login <url>' saves.`
		);
	}
	dotenv.populate(process.env as Record<string, string>, staged);
}

/**
 * Loads the JWT credentials from the ~/.harperdb/credentials.json file.
 */
export function loadCredentials(): TargetedCredentials {
	const credentialsFile = getCredentialsFile();
	try {
		return JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
	} catch (err) {
		if (err.code !== 'ENOENT') {
			throw new Error(`Error reading credentials file: ${err.message}`);
		}
	}
	return {
		last_target: null,
		targets: {},
	};
}

/**
 * Saves the JWT credentials to the ~/.harperdb/credentials.json file.
 */
export function saveCredentials(target: string, tokens: Tokens): void {
	if (!target) {
		throw new Error('Target is required to save credentials.');
	}

	target = normalizeTarget(target);
	const allCredentials = loadCredentials();

	allCredentials.targets ||= {};
	allCredentials.targets[target] = tokens;
	allCredentials.last_target = target;

	try {
		fs.mkdirSync(getCredentialsDir(), { recursive: true });
		fs.writeFileSync(getCredentialsFile(), JSON.stringify(allCredentials, null, 2), { mode: ownerRWDenyAllOthers });
	} catch (err) {
		throw new Error(`Error saving credentials file: ${err.message}`);
	}
}

/**
 * Deletes the credentials for a specific target or all if no target provided.
 */
export function clearCredentials(target: string): void {
	const credentialsFile = getCredentialsFile();
	if (target) {
		target = normalizeTarget(target);
		const allCredentials = loadCredentials();
		if (allCredentials && allCredentials.targets) {
			if (allCredentials.targets[target]) {
				delete allCredentials.targets[target];
			} else {
				console.error(`No credentials found for ${target}`);
				process.exit(1);
			}

			if (allCredentials.last_target === target) {
				allCredentials.last_target = null;
			}
			try {
				fs.writeFileSync(credentialsFile, JSON.stringify(allCredentials, null, 2), {
					mode: ownerRWDenyAllOthers,
				});
				console.log(`Logged out from ${target}`);
			} catch (err) {
				throw new Error(`Error clearing credentials file: ${err.message}`);
			}
		} else {
			console.error(`No credentials found for ${target}`);
			process.exit(1);
		}
	} else if (fs.existsSync(credentialsFile)) {
		try {
			fs.unlinkSync(credentialsFile);
			console.log('Logged out from all targets');
		} catch (err) {
			throw new Error(`Error clearing credentials file: ${err.message}`);
		}
	} else {
		console.log('No credentials found to clear.');
	}
}

function getCredentialsFile(): string {
	return path.join(getHomeDir(), '.harperdb', 'credentials.json');
}

function getCredentialsDir(): string {
	return path.join(getHomeDir(), '.harperdb');
}
