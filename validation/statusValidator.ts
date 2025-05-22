import Joi from 'joi';
import * as validator from './validationWrapper.js';

/**
 * Defined schemas for different status types
 */
export const STATUS_SCHEMAS = {
	primary: { allowedValues: null }, // Any string is valid
	maintenance: { allowedValues: null }, // Any string is valid
	availability: { allowedValues: ['Available', 'Unavailable'] },
};

export const STATUS_ALLOWED = Object.keys(STATUS_SCHEMAS);
export const STATUS_DEFAULT = 'primary';

/**
 * Pregenerate error messages to avoid repeated string concatenation
 */
const ERROR_MESSAGES = Object.entries(STATUS_SCHEMAS).reduce((messages, [id, schema]) => {
	if (schema.allowedValues) {
		messages[id] = `Status "${id}" only accepts these values: ${schema.allowedValues.join(', ')}`;
	}
	return messages;
}, {} as Record<string, string>);

/**
 * Creates the status validation schema using the STATUS_SCHEMAS definition
 */
const createStatusValidationSchema = () => {
	// Start with base schema
	let statusSchema = Joi.string().min(1).max(512);
	
	// Add conditional validations for each status type that has allowedValues
	Object.entries(STATUS_SCHEMAS).forEach(([id, schema]) => {
		if (schema.allowedValues) {
			statusSchema = statusSchema.when('id', {
				is: id,
				then: Joi.string().valid(...schema.allowedValues)
					.messages({
						'any.only': ERROR_MESSAGES[id]
					})
			});
		}
	});
	
	return statusSchema.required();
};

/**
 * Joi schema for validating status operations
 */
const setStatusSchema = Joi.object({
	id: Joi.string()
		.valid(...STATUS_ALLOWED)
		.required(),
	status: createStatusValidationSchema()
});

/**
 * Validates the status operation parameters
 * @param obj The status operation parameters to validate
 * @returns Error if validation fails, null otherwise
 */
export function validateStatus(obj: any) {
	return validator.validateBySchema(obj, setStatusSchema);
}