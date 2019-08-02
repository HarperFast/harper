"use strict";
let terms = require('../utility/hdbTerms');

class UpgradeObject {
    constructor() {
        this[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.CURRENT_VERSION] = '';
        this[terms.UPGRADE_JSON_FIELD_NAMES_ENUM.UPGRADE_VERSION] = '';

    }
}

module.exports = {
    UpgradeObject
};