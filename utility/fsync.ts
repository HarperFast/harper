import { fsyncSync } from 'node:fs';

// These codes mean the platform or filesystem cannot flush this handle, not that the write failed.
const UNSUPPORTED_SYNC_CODES = new Set(['EPERM', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EISDIR']);

export function isUnsupportedSyncError(error: unknown): boolean {
	return UNSUPPORTED_SYNC_CODES.has((error as NodeJS.ErrnoException)?.code ?? '');
}

export function fsyncTolerantSync(fd: number): void {
	try {
		fsyncSync(fd);
	} catch (error) {
		if (!isUnsupportedSyncError(error)) throw error;
	}
}
