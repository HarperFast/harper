import type { Stats } from 'node:fs';

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
