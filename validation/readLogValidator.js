const validate = require('validate.js'),
    validator = require('./validationWrapper.js'),
    moment = require('moment');

validate.extend(validate.validators.datetime, {
    // The value is guaranteed not to be null or undefined but otherwise it
    // could be anything.
    parse: function (value, options) {
        return +moment.utc(value);
    },
    // Input is a unix timestamp
    format: function (value, options) {
        var format = options.dateOnly ? "YYYY-MM-DD" : "YYYY-MM-DD hh:mm:ss";
        return moment.utc(value).format(format);
    }
});

const constraints = {
    from: {
        presence: false,
        datetime: {
            dateOnly: true
        }
    },
    until: {
        presence: false,
        datetime: {
            dateOnly: true
        }
    },
    level: {
        presence: false,
        inclusion: ['info', 'error', 'request', 'verbose']
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