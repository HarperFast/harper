'use strict';

const hdb_util = require('../utility/common_utils');
const log = require('../utility/logging/harper_logger');
const path = require('path');
const fs = require('fs');
const terms = require('../utility/hdbTerms');

module.exports = {
	getOldPropsValue,
};

//NOTE - from Sam - These methods were moved from the old upgrade module to preserve them in case they are needed/helpful
// for later upgrade code/directives.  If these do get added back into our code, make sure unit tests are written and the file is removed
// from `sonar.coverage.exclusions` in the `sonar-project.properties` config file

/**
 * Creates all directories specified in a directive file.
 *
 * @param hdb_base - value from HDB_ROOT in settings file
 * @param directive_paths
 */
function createRelativeDirectories(hdb_base, directive_paths) {
	if (hdb_util.isEmptyOrZeroLength(directive_paths)) {
		log.info('No upgrade directories to create.');
		return;
	}

	for (let dir_path of directive_paths) {
		// This is synchronous
		let new_dir_path = path.join(hdb_base, dir_path);
		log.info(`Creating directory ${new_dir_path}`);
		makeDirectory(new_dir_path);
	}
}

function createExplicitDirectories(directive_paths) {
	if (hdb_util.isEmptyOrZeroLength(directive_paths)) {
		log.info('No upgrade directories to create.');
		return;
	}
	for (let dir_path of directive_paths) {
		// This is synchronous
		try {
			log.info(`Creating directory ${dir_path}`);
			makeDirectory(dir_path);
		} catch (err) {
			log.error(`Error Creating path ${dir_path}.`);
			log.error(err);
			continue;
		}
	}
}

//This is synchronous to ensure everything runs in order.
/**
 * Recursively create directory specified.
 * @param targetDir - Directory to create
 * @param isRelativeToScript - Defaults to false, if true will use curr directory as the base path
 */
function makeDirectory(targetDir, { isRelativeToScript = false } = {}) {
	if (hdb_util.isEmptyOrZeroLength(targetDir)) {
		log.info('Invalid directory path.');
		return;
	}
	const sep = path.sep;
	const initDir = path.isAbsolute(targetDir) ? sep : '';
	const baseDir = isRelativeToScript ? __dirname : '.';

	targetDir.split(sep).reduce((parentDir, childDir) => {
		const curDir = path.resolve(baseDir, parentDir, childDir);
		try {
			if (curDir && curDir !== '/') {
				fs.mkdirSync(curDir, { mode: terms.HDB_FILE_PERMISSIONS });
				log.info(`Directory ${curDir} created`);
			}
		} catch (err) {
			if (err.code !== 'EEXIST') {
				throw err;
			}
		}
		return curDir;
	}, initDir);
}

/**
 * We need to make sure we are setting empty string for values that are null/undefined/empty string - PropertiesReader
 * castes values in some awkward ways and this covers those scenarios AND ensures we have default values set for new
 * config values that may have been added in a previous version (between when user installed HDB and is now upgrading)
 * @param prop_name
 * @param old_hdb_props
 * @param value_required
 * @returns {string|*}
 */
function getOldPropsValue(prop_name, old_hdb_props, value_required = false) {
	const old_val = old_hdb_props.getRaw(prop_name);
	if (hdb_util.isNotEmptyAndHasValue(old_val)) {
		return old_val;
	}
	if (value_required) {
		return terms.HDB_SETTINGS_DEFAULT_VALUES[prop_name];
	}
	return '';
}
