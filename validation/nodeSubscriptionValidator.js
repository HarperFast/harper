"use strict";

const validator = require('./validationWrapper.js');

const constraints = {
    channel : {
        presence : true
    },
    publish : {
        presence : true,
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

