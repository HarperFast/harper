'use strict';

const minimist = require('minimist');

module.exports = assignCMDENVVariables;

/**
 * This function receives a list of keys used to find if they exist in command line args &/or environment variables (command line always supercedes env vars).
 * if found they key/value is assigned to the return object
 * This is here and not common utils to avoid circular dependencies.
 * @param keys - arrays of keys to search for and assign to the return object
 * @param isConfigParam
 * @returns {{}}
 */
function assignCMDENVVariables(keys = [], isConfigParam = false) {
	if (!Array.isArray(keys)) {
		return {};
	}

	let envArgs;
	let cmdArgs;
	if (isConfigParam) {
		// Lowercase keys to make mapping to config params work
		envArgs = objKeysToLowerCase(process.env);
		cmdArgs = objKeysToLowerCase(minimist(process.argv));
	} else {
		envArgs = process.env;
		cmdArgs = minimist(process.argv);
	}

	let hdbSettings = {};
	for (let x = 0, length = keys.length; x < length; x++) {
		let setting = keys[x];

		//we set the env variable first which gets overridden by a command line arg (if present)
		if (cmdArgs[setting] !== undefined) {
			hdbSettings[setting] = cmdArgs[setting].toString().trim();
		} else if (envArgs[setting] !== undefined) {
			hdbSettings[setting] = envArgs[setting].toString().trim();
		}
	}
	return hdbSettings;
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
