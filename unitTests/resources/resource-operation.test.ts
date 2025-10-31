import { describe, it, before, after } from 'mocha';
import assert from 'node:assert/strict';
import { cleanupTestSandbox, createTestSandbox } from '../testUtils';
import { table } from '@/resources/databases';
import { setMainIsWorker } from '@/server/threads/manageThreads';
import { transaction } from '@/resources/transaction';
import '@/server/serverHelpers/serverUtilities'; // adds Resource.operation method

describe('Operations on resources', () => {
	let TargetTable;

	before(async function () {
		createTestSandbox();
		setMainIsWorker(true);
		TargetTable = table({
			table: 'TargetTable',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name' }],
		});
	});

	after(cleanupTestSandbox);

	it('It can search_by_conditions on a resource', async function () {
		const context = {};
		await transaction(context, () => {
			TargetTable.put(1, { name: 'one' }, context);
			TargetTable.put(2, { name: 'a prime' }, context);
			TargetTable.put(3, { name: 'another prime' }, context);
			TargetTable.put(42, { name: 'the answer to everything' }, context);
		});
		let operation_result = await TargetTable.operation({
			operation: 'search_by_conditions',
			conditions: [{ search_attribute: 'name', search_value: 'another prime' }],
		});
		let results = [];
		for await (let entry of operation_result) {
			results.push(entry);
		}
		assert.equal(results[0].name, 'another prime');
		await TargetTable.delete(2);
		operation_result = await TargetTable.operation({
			operation: 'search_by_conditions',
			conditions: [{ search_attribute: 'name', search_value: 'another prime' }],
		});
		results = [];
		for await (let entry of operation_result) {
			results.push(entry);
		}
		assert.equal(results[0].name, 'another prime');
	});
});
