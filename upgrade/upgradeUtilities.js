'use strict';

const hdbUtil = require('../utility/common_utils.js');
const configUtils = require('../config/configUtils.js');
const log = require('../utility/logging/harper_logger.js');
const path = require('path');
const fs = require('fs');
const terms = require('../utility/hdbTerms.ts');

module.exports = {
	getOldPropsValue,
};

//NOTE - from Sam - These methods were moved from the old upgrade module to preserve them in case they are needed/helpful
// for later upgrade code/directives.  If these do get added back into our code, make sure unit tests are written and the file is removed
// from `sonar.coverage.exclusions` in the `sonar-project.properties` config file

/**
 * Creates all directories specified in a directive file.
 *
 * @param hdbBase - value from HDB_ROOT in settings file
 * @param directivePaths
 */
function createRelativeDirectories(hdbBase, directivePaths) {
	if (hdbUtil.isEmptyOrZeroLength(directivePaths)) {
		log.info('No upgrade directories to create.');
		return;
	}

	for (let dirPath of directivePaths) {
		// This is synchronous
		let newDirPath = path.join(hdbBase, dirPath);
		log.info(`Creating directory ${newDirPath}`);
		makeDirectory(newDirPath);
	}
}

function createExplicitDirectories(directivePaths) {
	if (hdbUtil.isEmptyOrZeroLength(directivePaths)) {
		log.info('No upgrade directories to create.');
		return;
	}
	for (let dirPath of directivePaths) {
		// This is synchronous
		try {
			log.info(`Creating directory ${dirPath}`);
			makeDirectory(dirPath);
		} catch (err) {
			log.error(`Error Creating path ${dirPath}.`);
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
	if (hdbUtil.isEmptyOrZeroLength(targetDir)) {
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
 * @param propName
 * @param oldHdbProps
 * @param valueRequired
 * @returns {string|*}
 */
function getOldPropsValue(propName, oldHdbProps, valueRequired = false) {
	const oldVal = oldHdbProps.getRaw(propName);
	if (hdbUtil.isNotEmptyAndHasValue(oldVal)) {
		return oldVal;
	}
	if (valueRequired) {
		return configUtils.getDefaultConfig(propName);
	}
	return '';
}
