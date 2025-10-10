import Joi from 'joi';
import * as validator from './validationWrapper.js';
import { STATUS_DEFINITIONS, STATUS_IDS, DEFAULT_STATUS_ID, type StatusId } from '../server/status/definitions.ts';

// Re-export constants for backward compatibility
export const STATUS_SCHEMAS = STATUS_DEFINITIONS;
export const STATUS_ALLOWED = STATUS_IDS;
export const STATUS_DEFAULT = DEFAULT_STATUS_ID;

/**
 * Pregenerate error messages to avoid repeated string concatenation
 */
const ERROR_MESSAGES = Object.entries(STATUS_DEFINITIONS).reduce(
	(messages, [id, definition]) => {
		if (definition.allowedValues) {
			messages[id] = `Status "${id}" only accepts these values: ${definition.allowedValues.join(', ')}`;
		}
		return messages;
	},
	{} as Record<string, string>
);

/**
 * Creates the status validation schema using the STATUS_DEFINITIONS
 */
const createStatusValidationSchema = () => {
	// Start with base schema
	let statusSchema = Joi.string().min(1).max(512);

	// Add conditional validations for each status type that has allowedValues
	(Object.entries(STATUS_DEFINITIONS) as [StatusId, (typeof STATUS_DEFINITIONS)[StatusId]][]).forEach(
		([id, definition]) => {
			if (definition.allowedValues) {
				statusSchema = statusSchema.when('id', {
					is: id,
					then: Joi.string()
						.valid(...definition.allowedValues)
						.messages({
							'any.only': ERROR_MESSAGES[id],
						}),
				});
			}
		}
	);

	return statusSchema.required();
};

/**
 * Joi schema for validating status operations
 */
const setStatusSchema = Joi.object({
	id: Joi.string()
		.valid(...STATUS_ALLOWED)
		.required(),
	status: createStatusValidationSchema(),
});

/**
 * Validates the status operation parameters
 * @param obj The status operation parameters to validate
 * @returns Error if validation fails, null otherwise
 */
export function validateStatus(obj: any) {
	return validator.validateBySchema(obj, setStatusSchema);
}
