const validator = require('./validationWrapper.js');

const constraints = {
	user: {
		presence: true,
	},
	schema: {
		presence: true,
	},
	table: {
		presence: true,
	},
	operation: {
		presence: true,
	},
};
module.exports = function (deleteObject) {
	return validator.validateObject(deleteObject, constraints);
};
