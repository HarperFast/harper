'use strict';
let terms = require('../utility/hdbTerms');

class UpgradeObject {
	constructor(data_version, upgrade_version) {
		this[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.DATA_VERSION] = data_version;
		this[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION] = upgrade_version;
	}
}

module.exports = {
	UpgradeObject,
};
