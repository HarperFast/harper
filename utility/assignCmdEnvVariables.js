'use strict';

const minimist = require('minimist');

module.exports = assignCMDENVVariables;

/**
 * This function receives a list of keys used to find if they exist in command line args &/or environment variables (command line always supercedes env vars).
 * if found they key/value is assigned to the return object
 * This is here and not common utils to avoid circular dependencies.
 * @param keys - arrays of keys to search for and assign to the return object
 * @param is_config_param
 * @returns {{}}
 */
function assignCMDENVVariables(keys = [], is_config_param = false) {
	if (!Array.isArray(keys)) {
		return {};
	}

	let env_args;
	let cmd_args;
	if (is_config_param) {
		// Lowercase keys to make mapping to config params work
		env_args = objKeysToLowerCase(process.env);
		cmd_args = objKeysToLowerCase(minimist(process.argv));
	} else {
		env_args = process.env;
		cmd_args = minimist(process.argv);
	}

	let hdb_settings = {};
	for (let x = 0, length = keys.length; x < length; x++) {
		let setting = keys[x];

		//we set the env variable first which gets overridden by a command line arg (if present)
		if (cmd_args[setting] !== undefined) {
			hdb_settings[setting] = cmd_args[setting].toString().trim();
		} else if (env_args[setting] !== undefined) {
			hdb_settings[setting] = env_args[setting].toString().trim();
		}
	}
	return hdb_settings;
}

/**
 * Creates a new object where all its keys are lowercase
 * @param obj
 * @returns {{}}
 */
function objKeysToLowerCase(obj) {
	let key,
		keys = Object.keys(obj);
	let i = keys.length;
	const result = {};

	while (i--) {
		key = keys[i];
		result[key.toLowerCase()] = obj[key];
	}

	return result;
}
