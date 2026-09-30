import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';

export const PACKAGE_LOCK_FILES = [
	'package-lock.json',
	'npm-shrinkwrap.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'bun.lock',
	'bun.lockb',
];

export type UnreadableLockfile = { unreadable: string };

/** A packed source the resolver could not name: evidence of nothing, so it never matches. */
export const UNIDENTIFIED_SOURCE = 'unidentified';

/**
 * What an install came from, as the resolver already identified it — `npm:<name>@<version>`, `git:<commit>`, or
 * npm's `integrity:<sri>` for a source that has neither — and each root lockfile it left, by file name: its sha256,
 * or why it could not be read. An absent lockfile is not listed; a payload or a local path has no `source`.
 */
export type InstallFingerprint = { source?: string; lockfiles: Record<string, string | UnreadableLockfile> };

/** `matches` is false when anything differs, else null when any evidence is missing, unreadable or unidentified. */
export type InstallComparison = { matches: boolean | null; differs: string[]; peerSource?: string };

export async function fingerprintInstall(treePath: string, source?: string): Promise<InstallFingerprint> {
	const digests = await Promise.all(PACKAGE_LOCK_FILES.map((name) => hashLockfile(join(treePath, name))));
	const lockfiles: InstallFingerprint['lockfiles'] = {};
	PACKAGE_LOCK_FILES.forEach((name, index) => {
		if (digests[index] !== undefined) lockfiles[name] = digests[index];
	});
	return source === undefined ? { lockfiles } : { source, lockfiles };
}

async function hashLockfile(filePath: string): Promise<string | UnreadableLockfile | undefined> {
	const hash = createHash('sha256');
	try {
		for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		return code === 'ENOENT' ? undefined : { unreadable: typeof code === 'string' ? code : 'EUNKNOWN' };
	}
	return hash.digest('hex');
}

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function gitSourceIdentity(commit: string | undefined): string {
	const trimmed = commit?.trim();
	return trimmed && COMMIT.test(trimmed) ? `git:${trimmed}` : UNIDENTIFIED_SOURCE;
}

/**
 * A registry spec, a tag included, resolves to a `name@version` that can never change. A git spec npm packed itself,
 * or a tarball URL, has no such name, so npm's own integrity for what it packed stands in.
 */
export function packedSourceIdentity(
	fromRegistry: boolean,
	packed: { name?: string; version?: string; integrity?: string }
): string {
	if (fromRegistry) return packed.name && packed.version ? `npm:${packed.name}@${packed.version}` : UNIDENTIFIED_SOURCE;
	return packed.integrity ? `integrity:${packed.integrity}` : UNIDENTIFIED_SOURCE;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SOURCE = /^(?:(?:npm|git|integrity):\S{1,512}|unidentified)$/;
const identified = (source: string | undefined) => source !== undefined && source !== UNIDENTIFIED_SOURCE;

export function isInstallFingerprint(value: unknown): value is InstallFingerprint {
	const fingerprint = value as InstallFingerprint | undefined;
	const lockfiles = fingerprint?.lockfiles;
	if (!lockfiles || typeof lockfiles !== 'object' || Array.isArray(lockfiles)) return false;
	if (
		fingerprint.source !== undefined &&
		!(typeof fingerprint.source === 'string' && SOURCE.test(fingerprint.source))
	) {
		return false;
	}
	return Object.values(lockfiles).every((digest) =>
		typeof digest === 'string' ? SHA256_HEX.test(digest) : typeof digest?.unreadable === 'string'
	);
}

/** Only the lockfile names this node recognizes are compared, so a peer that recognizes more is not a difference. */
export function compareInstallFingerprints(own: InstallFingerprint | undefined, peer: unknown): InstallComparison {
	if (!isInstallFingerprint(own) || !isInstallFingerprint(peer)) return { matches: null, differs: [] };
	const differs: string[] = [];
	let unavailable = false;
	if (own.source !== undefined || peer.source !== undefined) {
		if (!identified(own.source) || !identified(peer.source)) unavailable = true;
		else if (own.source !== peer.source) differs.push('source');
	}
	for (const name of PACKAGE_LOCK_FILES) {
		const mine = own.lockfiles[name];
		const theirs = peer.lockfiles[name];
		if (mine === undefined && theirs === undefined) continue;
		if (mine === undefined || theirs === undefined) differs.push(name);
		else if (typeof mine !== 'string' || typeof theirs !== 'string') unavailable = true;
		else if (mine !== theirs) differs.push(name);
	}
	const comparison: InstallComparison = { matches: differs.length > 0 ? false : unavailable ? null : true, differs };
	if (differs.includes('source')) comparison.peerSource = peer.source;
	return comparison;
}

export function describeInstallDrift(
	peers: Array<{ node: string | null; comparison: InstallComparison }>
): string | undefined {
	const differing = peers.filter((peer) => peer.comparison.matches === false);
	if (differing.length === 0) return undefined;
	const detail = differing
		.map(({ node, comparison }) => {
			const fields = comparison.differs.map((field) =>
				field === 'source' && comparison.peerSource ? `source ${comparison.peerSource}` : field
			);
			return `${node ?? 'unknown'} (${fields.join(', ')})`;
		})
		.join(', ');
	return `Install fingerprints differ from this node's on ${differing.length} of ${peers.length} peer node(s): ${detail}.`;
}
