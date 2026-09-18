'use strict';

const assert = require('node:assert');
const { aggregateSchemaChangeErrors } = require('#src/utility/signalling');

describe('schema-change error aggregation', function () {
	it('preserves a status shared by every failed signalling leg', function () {
		const errors = [
			Object.assign(new Error('main conflict'), { statusCode: 409 }),
			Object.assign(new Error('peer conflict'), { statusCode: 409 }),
		];
		const aggregate = aggregateSchemaChangeErrors(errors, 'schema change failed');

		assert.strictEqual(aggregate.statusCode, 409);
		assert.deepStrictEqual(aggregate.errors, errors);
	});

	it('does not flatten mixed signalling failures into a client status', function () {
		const aggregate = aggregateSchemaChangeErrors(
			[Object.assign(new Error('main conflict'), { statusCode: 409 }), new Error('peer timeout')],
			'schema change failed'
		);

		assert.strictEqual(aggregate.statusCode, undefined);
	});
});
