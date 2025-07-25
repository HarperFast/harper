import * as terms from './hdbTerms.js';
import fs from 'node:fs';
import { noBootFile, getPropsFilePath } from './common_utils.js';

interface Env {
	get(key: string): string;
}

interface ErrorLogger {
	error(message: string): void;
}

/** isHdbInstalled checks for a valid installation of Harper based on the env
 *  arg's settings path and any boot props file it can find and returns true
 *  if an installation is found; false otherwise.
 */
export function isHdbInstalled(env: Env, logger: ErrorLogger) {
	try {
		fs.statSync(getPropsFilePath());
		fs.statSync(env.get(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
	} catch (err) {
		if (noBootFile()) return true;
		if (err.code === 'ENOENT') {
			// either boot props or settings file not found, hdb not installed
			return false;
		}

		logger.error(`Error checking for HDB install - ${err}`);
		throw err;
	}

	return true;
}
