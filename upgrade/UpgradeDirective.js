'use strict';

/**
 * Class that describes the data/scripts required to execute a new version upgrade.
 */
class UpgradeDirective {
	/**
	 * Constructor for an Upgrade Directive.
	 * @param version_number - The version of HDB this directive describes.
	 */
	constructor(version_number) {
		this.version = version_number;
		// Sync functions that must be set in class object within an array.
		this.sync_functions = [];
		// Async functions that must be set in class object within an array.
		this.async_functions = [];
	}
}

module.exports = UpgradeDirective;
