const assert = require('node:assert');
const {
	operationRegisteredHandler,
	getRemoteOperationInputSchema,
} = require('#src/server/serverHelpers/registeredOperations');
const { notifyThreadExit } = require('#src/server/threads/manageThreads');

describe('worker operation schema consistency', function () {
	for (const missingIndex of [0, 1, 2]) {
		it(`preserves a schema conflict with a schema-less worker at position ${missingIndex}`, function () {
			const name = `test_missing_and_conflicting_schemas_${missingIndex}`;
			const schemas = [
				{ type: 'object', properties: { value: { type: 'string' } } },
				{ type: 'object', properties: { value: { type: 'number' } } },
			];
			schemas.splice(missingIndex, 0, undefined);
			const workers = schemas.map((_, index) => 9_000_301 + missingIndex * 3 + index);
			try {
				for (let index = 0; index < schemas.length; index++) {
					operationRegisteredHandler({ message: { name, inputSchema: schemas[index], originator: workers[index] } });
				}
				assert.deepEqual(getRemoteOperationInputSchema(name), { issue: 'inconsistent' });
			} finally {
				for (const id of workers) notifyThreadExit(id);
			}
		});
	}
});
