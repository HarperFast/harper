import Joi from 'joi';
import * as validator from './validationWrapper.ts';
import { COMPARATORS } from '../resources/ResourceInterface.ts';

// A leaf condition. Both the canonical (attribute/comparator/value) and the
// legacy (search_attribute/search_type/search_value) names are accepted —
// `conformCondition` in resources/analytics/read.ts maps the latter onto the
// former.
const directConditionSchema = Joi.object({
	attribute: Joi.string(),
	search_attribute: Joi.string(),
	comparator: Joi.string().valid(...COMPARATORS),
	search_type: Joi.string().valid(...COMPARATORS),
	value: Joi.any(),
	search_value: Joi.any(),
})
	.or('attribute', 'search_attribute')
	.or('comparator', 'search_type')
	.or('value', 'search_value');

// A condition group. The nested `conditions` array is left unconstrained for
// the same reason searchByConditionsSchema leaves it unconstrained: shallow
// validation here is enough to reject scalar/wrong-type inputs at the boundary.
const groupConditionSchema = Joi.object({
	operator: Joi.string().valid('and', 'or'),
	conditions: Joi.array().required(),
});

// `.strict()` disables Joi's default type coercion so a numeric string like
// '1779834663816' is rejected for a `Joi.number()` field instead of being
// silently converted. Strictness propagates to child schemas.
const getAnalyticsSchema = Joi.object({
	metric: Joi.string().required(),
	start_time: Joi.number().greater(0),
	end_time: Joi.number().greater(0),
	get_attributes: Joi.array().items(Joi.string()),
	coalesce_time: Joi.boolean(),
	conditions: Joi.array().items(Joi.alternatives(groupConditionSchema, directConditionSchema)),
	log: Joi.string(),
	replicated: Joi.boolean(),
}).strict();

export function validateGetAnalytics(req: any): Error | undefined {
	return validator.validateBySchema(req, getAnalyticsSchema);
}
