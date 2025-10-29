import { describe, it, before, after } from 'mocha';
import assert from 'node:assert/strict';
import { createTestSandbox, cleanupTestSandbox } from '../testUtils';
import { table } from '@/resources/databases';
import { setMainIsWorker } from '@/server/threads/manageThreads';

describe('Permissions through Resource API', () => {
	let TestTable, restricted_user, authorized_role, attribute_authorized_role;

	before(async function () {
		createTestSandbox();
		setMainIsWorker(true); // TODO: Should be default until changed
		let RelatedTable = table({
			table: 'RelatedTestTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		TestTable = table({
			table: 'TestTable',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'prop1' },
				{ name: 'relatedId' },
				{ name: 'related', relationship: { from: 'relatedId' }, definition: { tableClass: RelatedTable } },
			],
		});
		for (let i = 0; i < 10; i++) {
			RelatedTable.put({ id: 'related-id-' + i, name: 'related name-' + i });
			TestTable.put({ id: 'id-' + i, name: i > 0 ? 'name-' + i : null, prop1: 'test', relatedId: 'related-id-' + i });
		}
		restricted_user = {
			role: {
				permission: {
					test: {
						tables: {
							TestTable: {
								read: false,
								insert: false,
								update: false,
								delete: false,
							},
						},
					},
				},
			},
		};
		authorized_role = {
			role: {
				permission: {
					test: {
						tables: {
							TestTable: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [],
							},
						},
					},
				},
			},
		};
		attribute_authorized_role = {
			role: {
				permission: {
					test: {
						tables: {
							TestTable: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'name',
										read: true,
										insert: true,
										update: true,
									},
									{
										attribute_name: 'related',
										read: true,
										insert: true,
										update: true,
									},
								],
							},
							RelatedTestTable: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'id',
										read: true,
										insert: true,
										update: true,
									},
								],
							},
						},
					},
				},
			},
		};
	});

	after(cleanupTestSandbox);

	it('Can not get without permission', async function () {
		let caught_error, result;
		try {
			result = TestTable.get('id-2', {
				user: restricted_user,
				authorize: true,
			});
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Unauthorized access'));
	});

	it('Can not write without permission', async function () {
		let caught_error, result;
		try {
			result = TestTable.put(
				'id-2',
				{ name: 'new record' },
				{
					user: restricted_user,
					authorize: true,
				}
			);
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Unauthorized access'));
		caught_error = null;
		try {
			result = TestTable.delete('id-2', {
				user: restricted_user,
				authorize: true,
			});
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Unauthorized access'));
	});

	it('Can get with permission', async function () {
		const request = {
			user: authorized_role,
			authorize: true,
			id: 'id-2',
		};
		let result = await TestTable.get(request, request);
		assert.equal(result.name, 'name-2');
		assert.equal(result.prop1, 'test');
	});

	it('Can get with (limited) permission', async function () {
		const request = {
			user: attribute_authorized_role,
			authorize: true,
			id: 'id-2',
		};
		let result = TestTable.get(request, request);
		assert.equal(result.name, 'name-2');
		assert.equal(result.prop1, undefined);
		assert.equal(result.related, undefined);
	});

	it('Can query with select with (limited) permission', async function () {
		const request = {
			user: attribute_authorized_role,
			authorize: true,
			url: '?id=id-2&select(name,related)',
		};
		let results = [];
		for await (let result of TestTable.get(request, request)) {
			results.push(result);
		}
		assert.equal(results[0].name, 'name-2');
		assert.equal(results[0].prop1, undefined);
		assert.equal(results[0].related.id, 'related-id-2');
		assert.equal(results[0].related.name, undefined);
	});

	it('Can query with selecting inaccessible attributes with (limited) permission', async function () {
		const request = {
			user: attribute_authorized_role,
			authorize: true,
			url: '?id=id-2&select(name,prop1,related{name})',
		};
		let results = [];
		for await (let result of TestTable.get(request, request)) {
			results.push(result);
		}
		assert.equal(results[0].name, 'name-2');
		assert.equal(results[0].prop1, undefined);
		assert.equal(results[0].related.id, 'related-id-2');
		assert.equal(results[0].related.name, undefined);
	});

	it('Can write with permission', async function () {
		let result = TestTable.put(
			'id-2',
			{ name: 'new record' },
			{
				user: attribute_authorized_role,
				authorize: true,
			}
		);
		TestTable.delete('id-2', {
			user: attribute_authorized_role,
			authorize: true,
		});
	});

	it('Can not write with restricted attribute', async function () {
		let caught_error, result;
		try {
			result = TestTable.put(
				'id-2',
				{ name: 'new record', prop1: 'change' },
				{
					user: restricted_user,
					authorize: true,
				}
			);
		} catch (error) {
			caught_error = error;
		}
		assert(caught_error.message.includes('Unauthorized access'));
	});
});
