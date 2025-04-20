const validator = require('./validationWrapper.js');
const { commonValidators } = require('./common_validators.js');

const constraints = {
	schema: {
		presence: true,
		format: commonValidators.schema_format,
		length: commonValidators.schema_length,
	},
	table: {
		presence: true,
		format: commonValidators.schema_format,
		length: commonValidators.schema_length,
	},
	conditions: {
		presence: true,
	},
};

module.exports = function (deleteObject) {
	return validator.validateObject(deleteObject, constraints);
};
