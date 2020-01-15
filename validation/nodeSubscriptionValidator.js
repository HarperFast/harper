"use strict";

const validator = require('./validationWrapper');
const hdb_terms = require('../utility/hdbTerms');
const validate = require('validate.js');

// Checks that system tables are not used for channel names
validate.validators.checkSysNames = function (value, options) {
    if (options === true) {

        let lc_value = value.toLowerCase();
        // Slice is used to remove colon from SC channel prefix
        let internal_sc_channel = hdb_terms.HDB_INTERNAL_SC_CHANNEL_PREFIX.slice(0, -1);
        let internal_sys_channel = hdb_terms.SYSTEM_SCHEMA_NAME;

        if (lc_value.startsWith(internal_sc_channel)) {
            return `invalid, channel cannot begin with reserved word: ${internal_sc_channel}`;
        } else if (lc_value.startsWith(internal_sys_channel)) {
            return `invalid, channel cannot begin with reserved word: ${internal_sys_channel}`;
        }

        return null;
    }
};

const constraints = {
    channel: {
        presence: true,
        checkSysNames: true
    },
    publish: {
        presence: true,
        inclusion: {
            within: [true, false],
            message: "must be a boolean"
        }
    },
    subscribe: {
        presence : true,
        inclusion: {
            within: [true, false],
            message: "must be a boolean"
        }
    }
};

module.exports = function(subscription) {
    return validator.validateObject(subscription, constraints);
};
