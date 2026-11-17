/**
 * What this server can do that an older one would silently do differently, advertised by
 * `registration_info` so a client can refuse instead of guessing from a version number. Dependency-free:
 * the CLI and the startup graph both import it.
 */

/** `restore_backup` reads an archive sent as its multipart `payload`; an older server ignores the payload. */
export const RESTORE_BACKUP_ARCHIVE_CAPABILITY = 'restore_backup_archive';

export const SERVER_CAPABILITIES: readonly string[] = Object.freeze([RESTORE_BACKUP_ARCHIVE_CAPABILITY]);
