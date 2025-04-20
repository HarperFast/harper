const validator = require('../validationWrapper.js');
const validate = require('validate.js');
const moment = require('moment');

validate.extend(validate.validators.datetime, {
	// The value is guaranteed not to be null or undefined but otherwise it
	// could be anything.
	parse: function (value, options) {
		return +moment.utc(value);
	},
	// Input is a unix timestamp
	format: function (value, options) {
		let format = options.dateOnly ? 'YYYY-MM-DD' : 'YYYY-MM-DD hh:mm:ss';
		return moment.utc(value).format(format);
	},
});

const constraints = {
	exp_date: {
		presence: true,
		datetime: {
			dateOnly: true,
			earliest: moment.utc(),
		},
	},
	company: {
		presence: true,
	},
	fingerprint: {
		presence: true,
	},
	ram_allocation: {
		presence: true,
		numericality: {
			onlyInteger: true,
			greaterThan: 0,
		},
	},
};

module.exports = function (licenseObject) {
	return validator.validateObject(licenseObject, constraints);
};
