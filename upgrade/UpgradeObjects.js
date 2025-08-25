'use strict';
let terms = require('../utility/hdbTerms.ts');

class UpgradeObject {
	constructor(dataVersion, upgradeVersion) {
		this[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.DATA_VERSION] = dataVersion;
		this[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION] = upgradeVersion;
	}
}

module.exports = {
	UpgradeObject,
};
