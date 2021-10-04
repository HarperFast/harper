'use strict';

const env_mngr = require('../utility/environment/environmentManager');
if (!env_mngr.isInitialized()) {
	env_mngr.initSync();
}
const comm = require('../utility/common_utils');
const hdb_terms = require('../utility/hdbTerms');
const PropertiesReader = require('properties-reader');
const fs = require('fs-extra');

module.exports = {
	changeSettingsFile,
};

/**
 * based on env/cmd vars the settings file will be rewritten
 */
function changeSettingsFile() {
	const ARGS = comm.assignCMDENVVariables(Object.keys(hdb_terms.HDB_SETTINGS_NAMES_REVERSE_LOOKUP));
	if (!ARGS) {
		return;
	}
	const settings_file_path = env_mngr.get(hdb_terms.HDB_SETTINGS_NAMES.SETTINGS_PATH_KEY);
	let settings = PropertiesReader(settings_file_path, { writer: { saveSections: false } });
	for (const [key, value] of Object.entries(ARGS)) {
		settings.set(key, value);
	}

	let new_settings_string = '';
	settings.each((key, value) => {
		if (key.startsWith(';') && comm.isEmptyOrZeroLength(value)) {
			new_settings_string += `${key}\n`;
		} else {
			new_settings_string += `${key} = ${value}\n`;
		}
	});

	fs.copySync(settings_file_path, `${settings_file_path}.bak`);
	fs.writeFileSync(settings_file_path, new_settings_string);
}
