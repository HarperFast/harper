import * as validator from './validationWrapper.js';

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
export default function (deleteObject: any): Error | undefined {
	return validator.validateObject(deleteObject, constraints);
};
