import { statSync, type Stats } from 'node:fs';
import { ClientError } from './errors/hdbError.ts';

/**
 * What a caller on this machine can tell the server about a file so the server can prove it sees the
 * same one: a remote caller cannot learn a server file's device and inode, so a match means the path
 * names the caller's own file on a shared filesystem.
 */
export interface FileIdentity {
	dev: number;
	ino: number;
	size: number;
	mtime_ms: number;
}

const IDENTITY_FIELDS = ['dev', 'ino', 'size', 'mtime_ms'] as const;

/**
 * The archive a caller names with `file=`, refused in its own terms: a missing or unreadable file must
 * not surface as an ENOENT or EACCES that a transport reads as an unreachable server.
 */
export function statArchiveFile(path: string): Stats {
	let stats: Stats;
	try {
		stats = statSync(path);
	} catch (error: any) {
		if (error?.code === 'ENOENT') throw new ClientError(`file=${path} does not exist`, 404);
		if (error?.code === 'EACCES' || error?.code === 'EPERM') {
			throw new ClientError(`file=${path} cannot be read: permission denied`, 403);
		}
		throw new ClientError(`file=${path} cannot be read: ${error?.message ?? error}`);
	}
	if (!stats.isFile()) throw new ClientError(`file=${path} is not a file`);
	return stats;
}

export function fileIdentity(stats: Stats): FileIdentity {
	return { dev: stats.dev, ino: stats.ino, size: stats.size, mtime_ms: stats.mtimeMs };
}

export function isFileIdentity(value: unknown): value is FileIdentity {
	if (!value || typeof value !== 'object') return false;
	const keys = Object.keys(value);
	return (
		keys.length === IDENTITY_FIELDS.length && IDENTITY_FIELDS.every((field) => Number.isFinite((value as any)[field]))
	);
}

export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
	return IDENTITY_FIELDS.every((field) => a[field] === b[field]);
}
