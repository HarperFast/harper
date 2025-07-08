import * as terms from './hdbTerms.js';
import fs from 'node:fs';
import { noBootFile, getPropsFilePath } from './common_utils.js';

export function isHdbInstalled(env: any, logger: any) {
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
