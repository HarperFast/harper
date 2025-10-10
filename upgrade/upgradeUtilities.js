'use strict';

const hdbUtil = require('../utility/common_utils.js');
const configUtils = require('../config/configUtils.js');

module.exports = {
	getOldPropsValue,
};

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
