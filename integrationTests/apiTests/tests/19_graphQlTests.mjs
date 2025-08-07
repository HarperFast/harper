import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { req, reqGraphQl } from '../utils/request.mjs';

describe('19. GraphQL tests', () => {
	//GraphQL tests Folder

	it('Insert one null into SubObject', () => {
		return req()
			.send({ operation: 'insert', table: 'SubObject', records: [{ id: '0', relatedId: '1', any: null }] })
			.expect((r) => assert.ok(r.body.message.includes('inserted 1 of 1 records'), r.text))
			.expect(200);
	});

	it('Insert into table Related', () => {
		return req()
			.send({
				operation: 'insert',
				table: 'Related',
				records: [
					{ id: '1', name: 'name-1', nestedIdObjectId: ['a', '1'], subObjectId: '1' },
					{
						id: '2',
						name: 'name-2',
						nestedIdObjectId: ['a', '2'],
						subObjectId: '2',
					},
					{ id: '3', name: 'name-3', nestedIdObjectId: ['a', '3'], subObjectId: '3' },
					{
						id: '4',
						name: 'name-4',
						nestedIdObjectId: ['a', '4'],
						subObjectId: '4',
					},
					{ id: '5', name: 'name-5', nestedIdObjectId: ['a', '5'], subObjectId: '5' },
				],
			})
			.expect((r) => assert.ok(r.body.message.includes('inserted 5 of 5 records'), r.text))
			.expect(200);
	});

	it('Insert into table SubObject', () => {
		return req()
			.send({
				operation: 'insert',
				table: 'SubObject',
				records: [
					{ id: '1', relatedId: '1', any: 'any-1' },
					{
						id: '2',
						relatedId: '2',
						any: 'any-2',
					},
					{ id: '3', relatedId: '3', any: 'any-3' },
					{ id: '4', relatedId: '4', any: 'any-4' },
					{
						id: '5',
						relatedId: '5',
						any: 'any-5',
					},
				],
			})
			.expect((r) => assert.ok(r.body.message.includes('inserted 5 of 5 records'), r.text))
			.expect(200);
	});

	it('Shorthand query', () => {
		return reqGraphQl()
			.send({ query: '{ Related { id name } }' })
			.expect((r) => {
				assert.equal(r.body.data.Related.length, 5, r.text);
				r.body.data.Related.forEach((row, i) => {
					assert.equal(row.id, (i + 1).toString(), r.text);
				});
			})
			.expect(200);
	});

	it('Named query', () => {
		return reqGraphQl()
			.send({ query: 'query GetRelated { Related { id name } }' })
			.expect((r) => {
				assert.equal(r.body.data.Related.length, 5, r.text);
				r.body.data.Related.forEach((row, i) => {
					assert.equal(row.id, (i + 1).toString(), r.text);
				});
			})
			.expect(200);
	});

	it('Named query with operationName', () => {
		return reqGraphQl()
			.send({ query: 'query GetRelated { Related { id, name } }', operationName: 'GetRelated' })
			.expect((r) => {
				assert.equal(r.body.data.Related.length, 5, r.text);
				r.body.data.Related.forEach((row, i) => {
					assert.equal(row.id, (i + 1).toString(), r.text);
				});
			})
			.expect(200);
	});

	it('Named query with operationName 2', () => {
		return reqGraphQl()
			.send({
				query: 'query GetRelated { Related { id, name } } query GetSubObject { SubObject { id relatedId } }',
				operationName: 'GetSubObject',
			})
			.expect((r) => {
				assert.equal(r.body.data.SubObject.length, 6, r.text);
				r.body.data.SubObject.forEach((row, i) => {
					assert.equal(row.id, i.toString(), r.text);
				});
			})
			.expect(200);
	});

	it('Query by primary key field', () => {
		return reqGraphQl()
			.send({ query: '{ Related(id: "1") { id name } }' })
			.expect((r) => assert.equal(r.body.data.Related[0].id, '1', r.text))
			.expect(200);
	});

	it('Multi resource query', () => {
		return reqGraphQl()
			.send({ query: '{ Related { id name } SubObject { id relatedId } }' })
			.expect((r) => {
				assert.equal(r.body.data.Related.length, 5, r.text);
				r.body.data.Related.forEach((row, i) => {
					assert.equal(row.id, (i + 1).toString(), r.text);
				});
				assert.equal(r.body.data.SubObject.length, 6, r.text);
				r.body.data.SubObject.forEach((row, i) => {
					assert.equal(row.id, i.toString(), r.text);
				});
			})
			.expect(200);
	});

	it('Query by variable non null no default', () => {
		return reqGraphQl()
			.send({ query: 'query Get($id: ID!) { Related(id: $id) { id name } }', variables: { id: '1' } })
			.expect((r) => assert.equal(r.body.data.Related[0].id, '1', r.text))
			.expect(200);
	});

	it('Query by variable non null with default with var', () => {
		return reqGraphQl()
			.send({ query: 'query Get($id: ID! = "1") { Related(id: $id) { id name } }', variables: { id: '1' } })
			.expect((r) => assert.equal(r.body.data.Related[0].id, '1', r.text))
			.expect(200);
	});

	it('Query by var nullable no default no var', () => {
		return reqGraphQl()
			.send({ query: 'query Get($any: Any) { SubObject(any: $any) { id any } }' })
			.expect((r) => assert.equal(r.body.data.SubObject[0].id, '0', r.text))
			.expect(200);
	});

	it('Query by var nullable w default with var', () => {
		return reqGraphQl()
			.send({
				query: 'query Get($any: Any = "any-1") { SubObject(any: $any) { id any } }',
				variables: { any: 'any-2' },
			})
			.expect((r) => assert.equal(r.body.data.SubObject[0].id, '2', r.text))
			.expect(200);
	});

	it('Query by var w default with null var', () => {
		return reqGraphQl()
			.send({
				query: 'query Get($any: Any = "any-1") { SubObject(any: $any) { id any } }',
				variables: { any: null },
			})
			.expect((r) => assert.equal(r.body.data.SubObject[0].id, '0', r.text))
			.expect(200);
	});

	it('Query by nested attribute', () => {
		return reqGraphQl()
			.send({ query: '{ SubObject(related: { name: "name-2" }) { id any } }' })
			.expect((r) => assert.equal(r.body.data.SubObject[0].id, '2', r.text))
			.expect(200);
	});

	it('Query by multiple nested attributes', () => {
		return reqGraphQl()
			.send({ query: '{ SubObject(any: "any-1", related: { name: "name-1" }) { id any } }' })
			.expect((r) => assert.equal(r.body.data.SubObject[0].id, '1', r.text))
			.expect(200);
	});

	it('Query by nested attribute primary key', () => {
		return reqGraphQl()
			.send({ query: '{ SubObject(related: { id: "2" }) { id any } }' })
			.expect((r) => assert.equal(r.body.data.SubObject[0].id, '2', r.text))
			.expect(200);
	});

	it('Query by doubly nested attribute', () => {
		return reqGraphQl()
			.send({ query: '{ SubObject(related: { subObject: { any: "any-3" } }) { id any } }' })
			.expect((r) => assert.equal(r.body.data.SubObject[0].id, '3', r.text))
			.expect(200);
	});

	it('Query by doubly nested attribute as var sub level', () => {
		return reqGraphQl()
			.send({
				query: 'query Get($subObject: Any) { SubObject(related: { subObject: $subObject }) { id any } }',
				variables: { subObject: { any: 'any-3' } },
			})
			.expect((r) => assert.equal(r.body.data.SubObject[0].id, '3', r.text))
			.expect(200);
	});

	it('Query by doubly nested attribute as var top-level', () => {
		return reqGraphQl()
			.send({
				query: 'query Get($related: Any) { SubObject(related: $related) { id any } }',
				variables: { related: { subObject: { any: 'any-3' } } },
			})
			.expect((r) => assert.equal(r.body.data.SubObject[0].id, '3', r.text))
			.expect(200);
	});

	it('Query by nested attribute as var sub level', () => {
		return reqGraphQl()
			.send({
				query: 'query Get($name: String) { SubObject(related: { name: $name }) { id any } }',
				variables: { name: 'name-2' },
			})
			.expect((r) => assert.equal(r.body.data.SubObject[0].id, '2', r.text))
			.expect(200);
	});

	it('Query by nested attribute as var top level', () => {
		return reqGraphQl()
			.send({
				query: 'query Get($related: Any) { SubObject(related: $related) { id any } }',
				variables: { related: { name: 'name-2' } },
			})
			.expect((r) => assert.equal(r.body.data.SubObject[0].id, '2', r.text))
			.expect(200);
	});

	it('Query with top level fragment', () => {
		return reqGraphQl()
			.send({ query: 'query Get { ...related } fragment related on Any { Related { id name } }' })
			.expect((r) => {
				assert.equal(r.body.data.Related.length, 5, r.text);
				r.body.data.Related.forEach((row, i) => {
					assert.equal(row.id, (i + 1).toString(), r.text);
				});
			})
			.expect(200);
	});

	it('Query with top level nested fragment', () => {
		return reqGraphQl()
			.send({
				query:
					'query Get { ...related } fragment related on Any { ...nested } fragment nested on Any { Related { id name } }',
			})
			.expect((r) => {
				assert.equal(r.body.data.Related.length, 5, r.text);
				r.body.data.Related.forEach((row, i) => {
					assert.equal(row.id, (i + 1).toString(), r.text);
				});
			})
			.expect(200);
	});

	it('Query w top level fragment multi resource', () => {
		return reqGraphQl()
			.send({
				query:
					'query Get { ...multiResourceFragment } fragment multiResourceFragment on Any { Related { id name } SubObject { id relatedId } }',
			})
			.expect((r) => {
				assert.equal(r.body.data.Related.length, 5, r.text);
				r.body.data.Related.forEach((row, i) => {
					assert.equal(row.id, (i + 1).toString(), r.text);
				});
				assert.equal(r.body.data.SubObject.length, 6, r.text);
				r.body.data.SubObject.forEach((row, i) => {
					assert.equal(row.id, i.toString(), r.text);
				});
			})
			.expect(200);
	});

	it('Query with inline fragment', () => {
		return reqGraphQl()
			.send({ query: 'query Get { Related(id: "1") { ...on Related { id name } } }' })
			.expect((r) => assert.equal(r.body.data.Related[0].id, '1', r.text))
			.expect(200);
	});

	it('Query with nested fragments', () => {
		return reqGraphQl()
			.send({
				query:
					'query Get { Related(id: "2") { ...relatedFields otherTable { ...id } } } fragment relatedFields on Related { ...id name } fragment id on Any { id }',
			})
			.expect((r) => assert.equal(r.body.data.Related[0].id, '2', r.text))
			.expect(200);
	});
});
