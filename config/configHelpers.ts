import * as path from 'node:path';
import * as hdbTerms from '../utility/hdbTerms.ts';

/**
 * Get the backup directory path for the given Harper root
 * @param hdbRoot - Harper root path
 * @returns Full path to backup directory
 */
export function getBackupDirPath(hdbRoot: string): string {
	return path.join(hdbRoot, hdbTerms.BACKUP_DIR_NAME);
}
