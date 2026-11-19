'use strict';

const assert = require('node:assert');
const { setOperationLogView, operationLogViewOf } = require('#src/utility/operationLogView');

describe('operationLogView', () => {
	it('keys a view by the body object without adding anything to the body', () => {
		const body = { operation: 'insert', records: [{ secret: 's' }] };
		const view = () => ({ operation: 'insert' });
		setOperationLogView(body, view);
		assert.strictEqual(operationLogViewOf(body), view);
		assert.deepStrictEqual(Object.keys(body), ['operation', 'records']);
		assert.strictEqual(operationLogViewOf({ ...body }), undefined);
	});

	it('has no view for non-objects', () => {
		assert.strictEqual(operationLogViewOf(undefined), undefined);
		assert.strictEqual(operationLogViewOf(null), undefined);
		assert.strictEqual(operationLogViewOf('insert'), undefined);
	});
});
