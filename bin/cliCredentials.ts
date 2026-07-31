import { getHomeDir } from '../utility/common_utils.ts';
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
 * echoed by the "Connecting to ..." line, written to `.env`, and emitted by `harper login --for-ci`.
 * Userinfo riding along would put the password in all four, so it is dropped here rather than at
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
	} catch {
		// If it's not a valid URL yet, we'll let it be handled later or it will fail
	}
	if (!normalized.endsWith('/')) {
		normalized += '/';
	}
	return normalized;
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
