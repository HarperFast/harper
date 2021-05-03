"use strict";

const validate = require('validate.js');
const validator = require('./validationWrapper');
const moment = require('moment');

validate.extend(validate.validators.datetime, {
    // The value is guaranteed not to be null or undefined but otherwise it
    // could be anything.
    parse: function (value) {
        return Date.parse(value);
    },
    // Input is a unix timestamp
    format: function (value) {
        const format = "YYYY-MM-DD hh:mm:ss";
        return moment(value).format(format);
    }
});

const constraints = {
    from: {
        presence: false,
        datetime: true
    },
    until: {
        presence: false,
        datetime: true
    },
    level: {
        presence: false,
        inclusion: {
            within: ['notify', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'],
            message: 'not valid'
        }
    },
    order: {
        presence: false,
        inclusion: ['asc', 'desc']
    },
    limit: {
        presence: false,
        numericality: true
    },
    start: {
        presence: false,
        numericality: true
    },
};

module.exports = function (object) {
    return validator.validateObject(object, constraints);
};