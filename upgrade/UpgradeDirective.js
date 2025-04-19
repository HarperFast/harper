'use strict';

/**
 * Class that describes the data/scripts required to execute a new version upgrade.
 */
class UpgradeDirective {
	/**
	 * Constructor for an Upgrade Directive.
	 * @param versionNumber - The version of HDB this directive describes.
	 */
	constructor(versionNumber) {
		this.version = versionNumber;
		// Sync functions that must be set in class object within an array.
		this.sync_functions = [];
		// Async functions that must be set in class object within an array.
		this.async_functions = [];
	}
}

module.exports = UpgradeDirective;
