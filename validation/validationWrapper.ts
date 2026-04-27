'use strict';

/**
 * validationWrapper.js
 *
 * This module is meant as a wrapper for calls to the validate module.  This wrapper serves 2 purposes:
 * it decouples the validate() call from the validate module, and it ensures a consistent "Error" return object
 * so we can rely on it for logging and reporting.
 *
 * There are a few cases where the validate module is called directly for functions like isBoolean.
 * These are rare enough for it not to be worth creating wrapper functions for those as well.
 */

import validate from 'validate.js';
import Joi from 'joi';

//This validator is added here b/c we are still on version 0.11.1 that does not include this build in functionality.  When
// we do update, we can remove.  The reason we have not is related to a breaking change on the "presence" validator rule
// that will require a lot of fixes on our end.  More here - https://validatejs.org/#changelog-0-12-0
// TODO: We are on version 0.13.x+ now, so we should be able to get rid of this. - WSM 2026-01-14
(validate as any).validators.type = function (value: any, options: any, _key: any, _attributes: any): string | null {
	// allow empty values by default (needs to be checked by "presence" check)
	if (value === null || typeof value === 'undefined') {
		return null;
	}

	return (validate as any).validators.type.checks[options](value) ? null : ' must be a ' + `'${options}' value`;
};

(validate as any).validators.type.checks = {
	Object: function (value: any): boolean {
		return validate.isObject(value) && !validate.isArray(value);
	},
	Array: validate.isArray,
	Integer: validate.isInteger,
	Number: validate.isNumber,
	String: validate.isString,
	Date: validate.isDate,
	Boolean: function (value: any): boolean {
		return typeof value === 'boolean';
	},
};

(validate as any).validators.hasValidFileExt = function (value: string, options: string[]): string | null {
	// allow non-string values by default (needs to be checked by "presence" and "type" checks)
	if (!validate.isString(value)) {
		return null;
	}
	if (value === '') return `can't be blank`;

	return options.filter((ext) => value.endsWith(ext)).length > 0
		? null
		: `must include one of the following valid file extensions - '${options.join("', '")}'`;
};

export {
	validateObject,
	validateObjectAsync,
	validateBySchema,
};

function validateObject(object: any, fileConstraints: any): Error | undefined {
	if (!object || !fileConstraints) {
		return new Error('validateObject parameters were null');
	}

	let validateResult = validate(object, fileConstraints, { format: 'flat' });
	if (!validateResult) return;
	return new Error(validateResult);
}

/**
 * Use this function for calls that support async/await
 * @param object - the json object being validated
 * @param fileConstraints - validation rules for the json object
 * @returns {Promise<Error|null>}
 */
async function validateObjectAsync(object: any, fileConstraints: any): Promise<Error | null> {
	if (!object || !fileConstraints) {
		return new Error('validateObject parameters were null');
	}

	try {
		await validate.async(object, fileConstraints, { format: 'flat' });
	} catch (err: any) {
		// unroll the array and make a full error message.
		let msg = err.join(`,`);
		return new Error(msg);
	}
	// If no error, just return null so this will behave as the non async version.
	return null;
}

/**
 *
 * @param {{}} object
 * @param {Joi.ObjectSchema} schema
 * @returns {*}
 */
function validateBySchema(object: any, schema: Joi.ObjectSchema): Error | undefined {
	let result = schema.validate(object, { allowUnknown: true, abortEarly: false, errors: { wrap: { label: "'" } } });

	if (result.error) {
		return new Error(result.error.message);
	}
}
