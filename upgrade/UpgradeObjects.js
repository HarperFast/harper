"use strict";
let terms = require('../utility/hdbTerms');

class UpgradeObject {
    constructor(current_version, upgrade_version) {
        this[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.CURRENT_VERSION] = current_version;
        this[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION] = upgrade_version;

    }
}

module.exports = {
    UpgradeObject
};
