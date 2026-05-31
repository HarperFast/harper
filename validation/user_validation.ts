import * as validator from './validationWrapper.ts';

const constraints = {
	username: {
		presence: true,
		exclusion: {
			within: ['system'],
			message: 'You cannot create tables within the system schema',
		},
	},
	password: {
		presence: true,
	},
	role: {
		presence: true,
		format: '[\\w\\-\\_]+',
	},
	active: {
		presence: true,
		inclusion: {
			within: [true, false],
			message: 'must be a boolean',
		},
	},
};

export function addUserValidation(object) {
	constraints.password.presence = true;
	constraints.username.presence = true;
	constraints.role.presence = true;
	constraints.active.presence = true;
	return validator.validateObject(object, constraints);
}

export function alterUserValidation(object) {
	constraints.password.presence = false;
	constraints.username.presence = true;
	constraints.role.presence = false;
	constraints.active.presence = false;
	return validator.validateObject(object, constraints);
}

export function dropUserValidation(object) {
	constraints.password.presence = false;
	constraints.username.presence = true;
	constraints.role.presence = false;
	constraints.active.presence = false;
	return validator.validateObject(object, constraints);
}
