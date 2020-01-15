"use strict";

const validator = require('./validationWrapper');
const hdb_terms = require('../utility/hdbTerms');
const validate = require('validate.js');

validate.validators.noSysNames = function (value, options, key, attributes) {
    if (options === true) {
        let lc_value = value.toLowerCase();
        if (lc_value.startsWith(hdb_terms.HDB_INTERNAL_SC_CHANNEL_PREFIX.slice(0, -1)) || lc_value.startsWith(hdb_terms.SYSTEM_SCHEMA_NAME)) {
            return `invalid, channel cannot begin with reserved word: ${value}`;
        }
    }

    return null;
};

const constraints = {
    channel: {
        presence: true,
        noSysNames: true
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
