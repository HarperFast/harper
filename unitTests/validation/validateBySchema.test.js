'use strict';

const assert = require('node:assert');
const Joi = require('joi');

const { validateBySchema, validateAndConvertBySchema } = require('#src/validation/validationWrapper');

const schema = Joi.object({
	name: Joi.string().required(),
	enabled: Joi.boolean().default(false),
});

describe('validateBySchema', () => {
	it('returns nothing for a valid object', () => {
		assert.equal(validateBySchema({ name: 'a' }, schema), undefined);
	});

	it('returns an error for an invalid object', () => {
		const error = validateBySchema({}, schema);

		assert.ok(error instanceof Error);
		assert.match(error.message, /'name'/);
	});
});

describe('validateAndConvertBySchema', () => {
	it('applies schema defaults and coercion to the returned value', () => {
		const { error, value } = validateAndConvertBySchema({ name: 'a', enabled: 'true' }, schema);

		assert.equal(error, undefined);
		assert.deepEqual(value, { name: 'a', enabled: true });
	});

	it('returns an error for an invalid object', () => {
		const { error } = validateAndConvertBySchema({ enabled: true }, schema);

		assert.ok(error instanceof Error);
		assert.match(error.message, /'name'/);
	});
});
