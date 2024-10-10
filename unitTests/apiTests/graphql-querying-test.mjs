/* eslint-disable sonarjs/no-nested-functions */
import { assert } from 'chai';
import { setupTestApp } from './setupTestApp.mjs';
import { request } from 'undici';

function restRequest(url) {
	return fetch(new URL(url, 'http://localhost:9926'));
}

function graphqlRequest(data, method = 'POST', accept = 'application/graphql-response+json') {
	const url = new URL('http://localhost:9926/graphql');

	if (method === 'GET') {
		for (const [key, value] of Object.entries(data)) {
			url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : value);
		}
	}

	return fetch(url, {
		method,
		headers: {
			'Content-Type': method === 'POST' ? 'application/json' : 'application/x-www-form-urlencoded',
			accept,
		},
		body: method === 'POST' ? JSON.stringify(data) : undefined,
	});
}

const related_records = [
	{ id: '0', name: 'zero', subObjectId: '00' },
	{ id: '1', name: 'one', subObjectId: '2' },
	{ id: '2', name: 'two', subObjectId: null },
	{ id: '3', name: 'three', subObjectId: null },
];

const sub_object_records = [
	{ id: '0', relatedId: '0', any: 'a' },
	{ id: '00', relatedId: '0', any: 'aa' },
	{ id: '01', relatedId: '1', any: 'aa' },
	{ id: '1', relatedId: '1', any: 'b' },
	{ id: '2', relatedId: '2', any: 'c' },
	{ id: '3', relatedId: '3', any: null },
];

function assertTestCase(testCase) {
	assert.ok('name' in testCase);
	assert.ok('graphql' in testCase);
	assert.ok('query' in testCase.graphql);
	assert.ok('rest' in testCase);
	assert.ok('resourceName' in testCase);
	assert.ok('expectedRecordCount' in testCase);
	assert.ok(
		(Array.isArray(testCase.rest) &&
			Array.isArray(testCase.resourceName) &&
			Array.isArray(testCase.expectedRecordCount) &&
			testCase.rest.length === testCase.resourceName.length &&
			testCase.rest.length === testCase.expectedRecordCount.length) ||
			(!Array.isArray(testCase.rest) &&
				!Array.isArray(testCase.resourceName) &&
				!Array.isArray(testCase.expectedRecordCount))
	);
}

function itFilter({ skip = false, only = false }) {
	return (...args) => {
		if (skip) {
			it.skip(...args);
		} else if (only) {
			// eslint-disable-next-line sonarjs/no-exclusive-tests
			it.only(...args);
		} else {
			it(...args);
		}
	};
}

describe('graphql querying', () => {
	before(async () => {
		await setupTestApp();

		for (const record of related_records) {
			// eslint-disable-next-line no-undef -- TODO: Remove after fixing global types
			tables.Related.put(record);
		}

		for (const record of sub_object_records) {
			// eslint-disable-next-line no-undef -- TODO: Remove after fixing global types
			tables.SubObject.put(record);
		}
	});

	// Add `skip: true` to the test case to skip it or `only: true` to only run that test case
	[
		{
			name: 'shorthand query',
			graphql: { query: '{ Related { id name } }' },
			rest: '/Related/?select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 4,
		},
		{
			name: 'unnamed query',
			graphql: { query: 'query { Related { id name } }' },
			rest: '/Related/?select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 4,
		},
		{
			name: 'named query',
			graphql: { query: 'query GetRelated { Related { id name } }' },
			rest: '/Related/?select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 4,
		},
		{
			name: 'named query with operationName',
			graphql: {
				query: 'query GetRelated { Related { id, name } } query GetSubObject { SubObject { id relatedId } }',
				operationName: 'GetRelated',
			},
			rest: '/Related/?select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 4,
		},
		{
			name: 'select nested object',
			graphql: { query: 'query GetRelated { Related { id name otherTable { id } } }' },
			rest: '/Related/?select(id,name,otherTable{id})',
			resourceName: 'Related',
			expectedRecordCount: 4,
		},
		{
			name: 'query by primary key field',
			graphql: { query: '{ Related(id: "0") { id name } }' },
			rest: '/Related/?id==0&select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 1,
		},
		{
			name: 'multi-resource query',
			graphql: { query: '{ Related { id name } SubObject { id relatedId } }' },
			rest: ['/Related/?select(id,name)', '/SubObject/?select(id,relatedId)'],
			resourceName: ['Related', 'SubObject'],
			expectedRecordCount: [4, 6],
		},
		{
			name: 'query by variable (non-null, no default)',
			graphql: {
				query: 'query Get($id: ID!) { Related(id: $id) { id name } }',
				variables: { id: '0' },
			},
			rest: '/Related/?id==0&select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 1,
		},
		{
			name: 'query by variable (non-null, with default)',
			graphql: {
				query: 'query Get($id: ID! = "0") { Related(id: $id) { id name } }',
			},
			rest: '/Related/?id==0&select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 1,
		},
		{
			name: 'query by variable (non-null, with default, with variable provided)',
			graphql: {
				query: 'query Get($id: ID! = "0") { Related(id: $id) { id name } }',
				variables: { id: '1' },
			},
			rest: '/Related/?id==1&select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 1,
		},
		{
			name: 'query by variable (nullable, no default, no variable provided)',
			graphql: {
				query: 'query Get($any: Any) { SubObject(any: $any) { id any } }',
			},
			rest: '/SubObject/?any==null&select(id,any)',
			resourceName: 'SubObject',
			expectedRecordCount: 1,
		},
		{
			name: 'query by variable (nullable, with default, no variable provided)',
			graphql: {
				query: 'query Get($any: Any = "a") { SubObject(any: $any) { id any } }',
			},
			rest: '/SubObject/?any==a&select(id,any)',
			resourceName: 'SubObject',
			expectedRecordCount: 1,
		},
		{
			name: 'query by variable (nullable, with default, with variable provided)',
			graphql: {
				query: 'query Get($any: Any = "a") { SubObject(any: $any) { id any } }',
				variables: { any: 'b' },
			},
			rest: '/SubObject/?any==b&select(id,any)',
			resourceName: 'SubObject',
			expectedRecordCount: 1,
		},
		{
			name: 'query by variable (nullable, with default, with variable provided (value is null))',
			graphql: {
				query: 'query Get($any: Any = "a") { SubObject(any: $any) { id any } }',
				variables: { any: null },
			},
			rest: '/SubObject/?any==null&select(id,any)',
			resourceName: 'SubObject',
			expectedRecordCount: 1,
		},
		{
			name: 'query by nested attribute',
			graphql: { query: '{ SubObject(related: { name: "zero" }) { id any } }' },
			rest: '/SubObject/?related.name==zero&select(id,any)',
			resourceName: 'SubObject',
			expectedRecordCount: 2,
		},
		{
			name: 'query by multiple nested attributes',
			graphql: { query: '{ SubObject(any: "aa", related: { name: "zero" }) { id any } }' },
			rest: '/SubObject/?any==aa&related.name==zero&select(id,any)',
			resourceName: 'SubObject',
			expectedRecordCount: 1,
		},
		{
			name: 'query by nested attribute primary key',
			graphql: { query: '{ SubObject(related: { id: "0" }) { id any } }' },
			rest: '/SubObject/?related.id==0&select(id,any)',
			resourceName: 'SubObject',
			expectedRecordCount: 2,
		},
		{
			name: 'query by doubly nested attribute',
			graphql: { query: '{ SubObject(related: { subObject: { any: "aa" } }) { id any } }' },
			rest: '/SubObject/?related.subObject.any==aa&select(id,any)',
			resourceName: 'SubObject',
			expectedRecordCount: 2,
		},
		{
			name: 'query by nested attribute as variable (sub-level)',
			graphql: {
				query: 'query Get($name: String) { SubObject(related: { name: $name }) { id any } }',
				variables: { name: 'zero' },
			},
			rest: '/SubObject/?related.name==zero&select(id,any)',
			resourceName: 'SubObject',
			expectedRecordCount: 2,
		},
		{
			name: 'query by nested attribute as variable (top-level)',
			graphql: {
				query: 'query Get($related: Any) { SubObject(related: $related) { id any } }',
				variables: { related: { name: 'zero' } },
			},
			rest: '/SubObject/?related.name==zero&select(id,any)',
			resourceName: 'SubObject',
			expectedRecordCount: 2,
		},
		{
			name: 'query by doubly nested attribute as variable (sub-level)',
			graphql: {
				query: 'query Get($subObject: Any) { SubObject(related: { subObject: $subObject }) { id any } }',
				variables: { subObject: { any: 'aa' } },
			},
			rest: '/SubObject/?related.subObject.any==aa&select(id,any)',
			resourceName: 'SubObject',
			expectedRecordCount: 2,
		},
		{
			name: 'query by doubly nested attribute as variable (top-level)',
			graphql: {
				query: 'query Get($related: Any) { SubObject(related: $related) { id any } }',
				variables: { related: { subObject: { any: 'aa' } } },
			},
			rest: '/SubObject/?related.subObject.any==aa&select(id,any)',
			resourceName: 'SubObject',
			expectedRecordCount: 2,
		},
		{
			name: 'query with top level fragment',
			graphql: {
				query: `
				query Get {
					...related
				}

				fragment related on Any {
					Related { id name }
				}`,
			},
			rest: '/Related/?select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 4,
		},
		{
			name: 'query with top level nested fragment',
			graphql: {
				query: `
				query Get {
					...related
				}

				fragment related on Any {
					...nested
				}
					
				fragment nested on Any {
					Related { id name }
				}`,
			},
			rest: '/Related/?select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 4,
		},
		{
			name: 'query with top level inline fragment',
			graphql: {
				query: `
				query Get {
					...on Any {
						Related { id name }
					}
				}`,
			},
			rest: '/Related/?select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 4,
		},
		{
			name: 'query with top level inline nested fragment',
			graphql: {
				query: `
				query Get {
					...on Any {
						...on Any {
							Related { id name }
						}
					}
				}`,
			},
			rest: '/Related/?select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 4,
		},
		{
			name: 'query with top level fragment (multi-resource)',
			graphql: {
				query: `
				query Get {
					...multiResourceFragment
				}

				fragment multiResourceFragment on Any {
					Related { id name }
					SubObject { id relatedId }
				}`,
			},
			rest: ['/Related/?select(id,name)', '/SubObject/?select(id,relatedId)'],
			resourceName: ['Related', 'SubObject'],
			expectedRecordCount: [4, 6],
		},
		{
			name: 'query with fragment',
			graphql: {
				query: `
				query Get {
					Related(id: "0") {
						...relatedFields
					}
				}

				fragment relatedFields on Related {
					id
					name
				}`,
			},
			rest: '/Related/?id==0&select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 1,
		},
		{
			name: 'query with inline fragment',
			graphql: {
				query: `
				query Get {
					Related(id: "0") {
						...on Related {
							id
							name
						}
					}
				}`,
			},
			rest: '/Related/?id==0&select(id,name)',
			resourceName: 'Related',
			expectedRecordCount: 1,
		},
		{
			name: 'query with nested fragments',
			graphql: {
				query: `
				query Get {
					Related(id: "0") {
						...relatedFields
						otherTable {
							...id
						}
					}
				}

				fragment relatedFields on Related {
					...id
					name
				}


				fragment id on Any {
					id
				}`,
			},
			rest: '/Related/?id==0&select(id,name,otherTable{id})',
			resourceName: 'Related',
			expectedRecordCount: 1,
		},
		{
			name: 'query with multiple fragment types',
			graphql: {
				query: `
				query Get {
					Related(id: "0") {
						...relatedFields
						otherTable {
							...id
						}
					}
				}

				fragment relatedFields on Related {
					...id
					...on Any {
						name
					}
				}


				fragment id on Any {
					id
				}`,
			},
			rest: '/Related/?id==0&select(id,name,otherTable{id})',
			resourceName: 'Related',
			expectedRecordCount: 1,
		},
	].forEach(({ name, graphql, rest, resourceName, expectedRecordCount, skip, only }) => {
		itFilter({ skip, only })(`handles ${name}`, async () => {
			// Sanity check the test case against human error
			assertTestCase({ name, graphql, rest, resourceName, expectedRecordCount });

			// The REST call is the expected result
			let expected = {};
			if (Array.isArray(rest)) {
				// if there are multiple rest calls, do all of them and then assign the results to the expected resource names
				// eslint-disable-next-line sonarjs/no-nested-functions
				const expectedData = await Promise.all(rest.map((url) => restRequest(url).then((response) => response.json())));
				// Order matters here, so the test case needs to be structure respectively. See the multi-resource test case for an example.
				for (let i = 0; i < rest.length; i++) {
					assert.equal(expectedData[i].length, expectedRecordCount[i]);
					expected[resourceName[i]] = expectedData[i];
				}
			} else {
				const restResponse = await restRequest(rest);
				expected[resourceName] = await restResponse.json();
				assert.equal(expected[resourceName].length, expectedRecordCount);
			}

			const postResponse = await graphqlRequest(graphql, 'POST');
			assert.equal(postResponse.status, 200);
			assert.equal(postResponse.headers.get('Content-Type'), 'application/graphql-response+json; charset=utf-8');
			const actualPost = await postResponse.json();

			const getResponse = await graphqlRequest(graphql, 'GET');
			assert.equal(getResponse.status, 200);
			assert.equal(getResponse.headers.get('Content-Type'), 'application/graphql-response+json; charset=utf-8');
			const actualGet = await getResponse.json();

			// The result for GraphQL will be in a slightly different shape than the REST call.
			// We use the `resourceName` to ensure that the data is in the correct shape for the deep equal comparison.
			assert.deepStrictEqual(actualPost.data, expected);
			// The GraphQL responses should be the same regardless of method
			assert.deepStrictEqual(actualGet, actualPost);
		});
	});

	it('should only allow GET and POST requests', () =>
		Promise.all(
			// 'CONNECT' isn't allowed anyways, and we will handle that when we figure out subscriptions
			// 'HEAD', 'OPTIONS', 'TRACE' do not have a body.
			['DELETE', 'PATCH', 'PUT', 'TRACE'].map((method) =>
				request('http://localhost:9926/graphql', { method })
					.then((response) => {
						assert.equal(response.statusCode, 405);
						assert.equal(response.headers['allow'], 'GET, POST');
						return response.body.json();
					})
					.then((json) => assert.deepStrictEqual(json, { errors: [{ message: 'Method Not Allowed' }] }))
			)
		));

	it('errors on non-executable definitions', () =>
		Promise.all(
			[
				'schema { query: Query }',
				'scalar CustomScalar',
				'type CustomType { field: String }',
				'interface CustomInterface { field: String }',
				'union CustomUnion = TypeA | TypeB',
				'enum CustomEnum { VALUE }',
				'input CustomInput { field: String }',
				'directive @customDirective on FIELD_DEFINITION',
			].flatMap((definition) =>
				['application/graphql-response+json', 'application/json'].map((accept) =>
					graphqlRequest({ query: definition }, 'POST', accept)
						.then((response) => {
							assert.equal(response.status, accept === 'application/graphql-response+json' ? 400 : 200);
							return response.json();
						})
						.then((json) => assert.ok(json.errors[0].message.includes('Unexpected non-executable definition type')))
				)
			)
		));

	[
		{
			name: 'missing data',
			data: null,
			expectedErrorMessage: 'Request body must be an object.',
			expectedErrorCodes: {
				'application/json': 400,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'missing query in data',
			data: { foo: 'bar' },
			expectedErrorMessage: 'Request body must contain a `query` field.',
			expectedErrorCodes: {
				'application/json': 400,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: "query isn't a string",
			data: { query: 0 },
			expectedErrorMessage: 'Request body `query` field must be a string.',
			expectedErrorCodes: {
				'application/json': 400,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: "operationName isn't a string",
			data: { query: '', operationName: 0 },
			expectedErrorMessage: 'Request body `operationName` field must be a string.',
			expectedErrorCodes: {
				'application/json': 400,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: "variables isn't an object",
			data: { query: '', variables: 0 },
			expectedErrorMessage: 'Request body `variables` field must be an object.',
			expectedErrorCodes: {
				'application/json': 400,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'enum values',
			data: { query: '{ Related(foo: Any) { id name } }' },
			expectedErrorMessage: 'Argument type, EnumValue, is not supported.',
			expectedErrorCodes: {
				'application/json': 200,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'enum values (object field)',
			data: { query: '{ Related(foo: { bar: Any }) { id name } }' },
			expectedErrorMessage: 'Value type, EnumValue, is not supported.',
			expectedErrorCodes: {
				'application/json': 200,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'list argument',
			data: { query: '{ Related(foo: [Any]) { id name } }' },
			expectedErrorMessage: 'Argument type, ListValue, is not supported.',
			expectedErrorCodes: {
				'application/json': 200,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'enum values (variable default value)',
			data: { query: 'query Get($id: ID = Any) { Related { id name } }' },
			expectedErrorMessage: 'Value type, EnumValue, is not supported.',
			expectedErrorCodes: {
				'application/json': 200,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'missing fragment',
			data: { query: 'query Get { ...related }' },
			expectedErrorMessage: 'Fragment `related` not found.',
			expectedErrorCodes: {
				'application/json': 200,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'missing required variable',
			data: { query: 'query Get($id: ID!) { Related { id name } }' },
			expectedErrorMessage: 'Variable $id is required, but not provided.',
			expectedErrorCodes: {
				'application/json': 200,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'subscriptions unsupported',
			data: { query: 'subscription { Related { id name } }' },
			expectedErrorMessage: 'Subscriptions are not supported.',
			expectedErrorCodes: {
				'application/json': 200,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'mutations unsupported',
			data: { query: 'mutation { Related { id name } }' },
			expectedErrorMessage: 'Mutations are not supported yet.',
			expectedErrorCodes: {
				'application/json': 200,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'non-isolated unnamed operations',
			data: { query: '{ Related { ...related } } fragment related on Any { id name }' },
			expectedErrorMessage: 'Unnamed operations are only allowed when there is a single operation in the document.',
			expectedErrorCodes: {
				'application/json': 200,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'duplicate operation definition',
			data: { query: 'query Get { Related { id name } } query Get { Related { id name } }' },
			expectedErrorMessage: 'Duplicate operation definition: Get',
			expectedErrorCodes: {
				'application/json': 200,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'multiple operations without operationName',
			data: { query: 'query Get1 { Related { id name } } query Get2 { Related { id name } }' },
			expectedErrorMessage: 'Operation name is required when there are multiple operations in the document.',
			expectedErrorCodes: {
				'application/json': 200,
				'application/graphql-response+json': 400,
			},
		},
		{
			name: 'missing operation',
			data: {
				query: 'query Foo { Related { id name } }',
				operationName: 'Bar',
			},
			expectedErrorMessage: 'Operation `Bar` not found.',
			expectedErrorCodes: {
				'application/json': 200,
				'application/graphql-response+json': 400,
			},
		},
	].forEach(({ skip, only, name, data, expectedErrorMessage, expectedErrorCodes }) => {
		itFilter({ skip, only })(`errors on ${name}`, () =>
			Promise.all(
				Object.entries(expectedErrorCodes).map(([accept, expectedCode]) =>
					graphqlRequest(data, 'POST', accept)
						.then((response) => {
							assert.equal(response.status, expectedCode);
							return response.json();
						})
						.then((json) => assert.equal(json.errors[0].message, expectedErrorMessage))
				)
			)
		);
	});
});
