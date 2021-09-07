const validator = require('./validationWrapper');
const { common_validators } = require('./common_validators');

const constraints = {
	schema: {
		presence: true,
		format: common_validators.schema_format,
		length: common_validators.schema_length,
	},
	table: {
		presence: true,
		format: common_validators.schema_format,
		length: common_validators.schema_length,
	},
	conditions: {
		presence: true,
	},
};

module.exports = function (delete_object) {
	return validator.validateObject(delete_object, constraints);
};
