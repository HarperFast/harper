import * as terms from './hdbTerms.js';
import * as fs from 'fs-extra';
import { noBootFile, getPropsFilePath } from './common_utils.js';

export async function isHdbInstalled(env: any, logger: any) {
	try {
		await fs.stat(getPropsFilePath());
		await fs.stat(env.get(terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY));
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
