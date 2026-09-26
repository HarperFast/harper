'use strict';

const assert = require('node:assert');
const { setupTestDBPath } = require('../../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');

// Parse-level behavior of the `@decide` directive: the attribute type selects the decision
// leaf, the closed set is validated at load, and derived-field ownership is exclusive.
describe('@decide directive parsing', () => {
	before(() => setupTestDBPath());

	const rejects = (schema, pattern) =>
		assert.rejects(loadGQLSchema(schema), (err) => {
			assert.equal(err.statusCode, 400, `should be a client error: ${err.message}`);
			assert.match(err.message, pattern);
			return true;
		});

	it('resolves a String attribute with values to an enum leaf, with defaults filled in', async () => {
		await loadGQLSchema(`type DecideStr @table {
			id: ID @primaryKey
			body: String
			route: String @decide(source: "body", values: ["billing", "refund", "bug"])
		}`);
		const attr = tables.DecideStr.attributes.find((a) => a.name === 'route');
		assert.deepEqual(attr.decide, { source: 'body', model: 'default', schema: { enum: ['billing', 'refund', 'bug'] } });
		assert.equal(attr.version, undefined, 'a decision does not carry a model version: no reindex on model change');
		assert.equal(attr.indexed, undefined, 'no index is attached implicitly');
	});

	it('keeps model, confidence and instructions, and a Float confidence attribute may be indexed', async () => {
		await loadGQLSchema(`type DecideFull @table {
			id: ID @primaryKey
			body: String
			route: String @decide(source: "body", values: ["a", "b"], model: "router", confidence: "routeConfidence", instructions: "Route the ticket.")
			routeConfidence: Float @indexed
		}`);
		const attr = tables.DecideFull.attributes.find((a) => a.name === 'route');
		assert.deepEqual(attr.decide, {
			source: 'body',
			model: 'router',
			confidence: 'routeConfidence',
			instructions: 'Route the ticket.',
			schema: { enum: ['a', 'b'] },
		});
	});

	it('resolves a Boolean attribute to a boolean leaf', async () => {
		await loadGQLSchema(`type DecideBool @table {
			id: ID @primaryKey
			body: String
			urgent: Boolean @decide(source: "body")
		}`);
		const attr = tables.DecideBool.attributes.find((a) => a.name === 'urgent');
		assert.deepEqual(attr.decide.schema, { type: 'boolean' });
	});

	it('resolves an Int attribute with minimum/maximum to a bounded integer leaf', async () => {
		await loadGQLSchema(`type DecideInt @table {
			id: ID @primaryKey
			body: String
			severity: Int @decide(source: "body", minimum: 1, maximum: 5)
		}`);
		const attr = tables.DecideInt.attributes.find((a) => a.name === 'severity');
		assert.deepEqual(attr.decide.schema, { type: 'integer', minimum: 1, maximum: 5 });
	});

	it('rejects an unsupported attribute type (loud-fail, 400)', () =>
		rejects(
			`type DecideFloat @table {
				id: ID @primaryKey
				body: String
				score: Float @decide(source: "body", minimum: 1, maximum: 5)
			}`,
			/String, Boolean or Int/
		));

	it('rejects a String attribute without values', () =>
		rejects(
			`type DecideNoValues @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body")
			}`,
			/requires "values"/
		));

	it('rejects a one-value set and a duplicate value (the primitive bounds apply at load)', async () => {
		await rejects(
			`type DecideOne @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: ["only"])
			}`,
			/@decide on "route":/
		);
		await rejects(
			`type DecideDup @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: ["a", "a"])
			}`,
			/@decide on "route":/
		);
	});

	it('rejects values on a Boolean or Int attribute, and a range on a String attribute', async () => {
		await rejects(
			`type DecideBoolValues @table {
				id: ID @primaryKey
				body: String
				urgent: Boolean @decide(source: "body", values: ["yes", "no"])
			}`,
			/Boolean attribute/
		);
		await rejects(
			`type DecideIntValues @table {
				id: ID @primaryKey
				body: String
				severity: Int @decide(source: "body", values: ["1", "2"])
			}`,
			/not "values", on an Int attribute/
		);
		await rejects(
			`type DecideStrRange @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: ["a", "b"], minimum: 1)
			}`,
			/only on an Int attribute/
		);
	});

	it('rejects an Int attribute without both bounds, with a bound outside 32 bits, or with a span the primitive refuses', async () => {
		await rejects(
			`type DecideIntHalf @table {
				id: ID @primaryKey
				body: String
				severity: Int @decide(source: "body", minimum: 1)
			}`,
			/both "minimum" and "maximum"/
		);
		await rejects(
			`type DecideIntWide @table {
				id: ID @primaryKey
				body: String
				severity: Int @decide(source: "body", minimum: 0, maximum: 4294967296)
			}`,
			/-2147483648 to 2147483647/
		);
		await rejects(
			`type DecideIntSpan @table {
				id: ID @primaryKey
				body: String
				severity: Int @decide(source: "body", minimum: 0, maximum: 1000)
			}`,
			/@decide on "severity":/
		);
	});

	it('rejects non-literal, unknown and duplicate arguments', async () => {
		await rejects(
			`type DecideNonStr @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: body, values: ["a", "b"])
			}`,
			/string literal/
		);
		await rejects(
			`type DecideBadValues @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: "a")
			}`,
			/list of string literals/
		);
		await rejects(
			`type DecideBadMin @table {
				id: ID @primaryKey
				body: String
				severity: Int @decide(source: "body", minimum: "1", maximum: 5)
			}`,
			/integer literal/
		);
		await rejects(
			`type DecideUnknownArg @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: ["a", "b"], samples: "3")
			}`,
			/unknown argument "samples"/
		);
		await rejects(
			`type DecideDupArg @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", source: "body", values: ["a", "b"])
			}`,
			/more than once/
		);
	});

	it('rejects a missing source, an unknown source, and a prototype-key source', async () => {
		await rejects(
			`type DecideNoSource @table {
				id: ID @primaryKey
				body: String
				route: String @decide(values: ["a", "b"])
			}`,
			/requires a "source"/
		);
		await rejects(
			`type DecideBadSource @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "bdoy", values: ["a", "b"])
			}`,
			/unknown source field "bdoy"/
		);
		await rejects(
			`type DecideProtoSource @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "toString", values: ["a", "b"])
			}`,
			/"toString" is an Object.prototype key/
		);
	});

	it('rejects a confidence field that is unknown, not Float, non-null, or the source/attribute itself', async () => {
		await rejects(
			`type DecideConfUnknown @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: ["a", "b"], confidence: "nope")
			}`,
			/unknown confidence field "nope"/
		);
		await rejects(
			`type DecideConfType @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: ["a", "b"], confidence: "routeConfidence")
				routeConfidence: String
			}`,
			/Float confidence attribute/
		);
		await rejects(
			`type DecideConfNonNull @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: ["a", "b"], confidence: "routeConfidence")
				routeConfidence: Float!
			}`,
			/cannot be declared non-null/
		);
		await rejects(
			`type DecideConfSelf @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: ["a", "b"], confidence: "route")
			}`,
			/must be different fields/
		);
		await rejects(
			`type DecideConfSource @table {
				id: ID @primaryKey
				body: Float
				route: String @decide(source: "body", values: ["a", "b"], confidence: "body")
			}`,
			/must be different fields/
		);
	});

	it('rejects an Object.prototype key as the decided, source or confidence field', async () => {
		await rejects(
			`type DecideProtoAttr @table {
				id: ID @primaryKey
				body: String
				valueOf: String @decide(source: "body", values: ["a", "b"])
			}`,
			/"valueOf" is an Object.prototype key/
		);
		await rejects(
			`type DecideProtoConf @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: ["a", "b"], confidence: "hasOwnProperty")
				hasOwnProperty: Float
			}`,
			/"hasOwnProperty" is an Object.prototype key/
		);
	});

	it('rejects a non-null target, a primary-key target, and a @computed target', async () => {
		await rejects(
			`type DecideNonNull @table {
				id: ID @primaryKey
				body: String
				route: String! @decide(source: "body", values: ["a", "b"])
			}`,
			/cannot be declared non-null/
		);
		await rejects(
			`type DecidePk @table {
				id: String @primaryKey @decide(source: "body", values: ["a", "b"])
				body: String
			}`,
			/@primaryKey or @computed/
		);
		await rejects(
			`type DecideComputed @table {
				id: ID @primaryKey
				body: String
				route: String @computed(from: "body") @decide(source: "body", values: ["a", "b"])
			}`,
			/@primaryKey or @computed/
		);
	});

	it('rejects a field that carries both @embed and @decide', () =>
		rejects(
			`type DecideBoth @table {
				id: ID @primaryKey
				body: String
				both: [Float] @embed(source: "body", model: "default") @decide(source: "body", values: ["a", "b"])
			}`,
			/String, Boolean or Int|both write "both"/
		));

	it('rejects two directives writing one field, and a directive deriving from another directive’s output', async () => {
		await rejects(
			`type DecideSharedConfidence @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: ["a", "b"], confidence: "confidence")
				urgent: Boolean @decide(source: "body", confidence: "confidence")
				confidence: Float
			}`,
			/both write "confidence"/
		);
		await rejects(
			`type DecideEmbedSame @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: ["a", "b"])
				vector: [Float] @embed(source: "route", model: "default")
			}`,
			/derives from "route", which @decide on "route" writes/
		);
		await rejects(
			`type DecideChain @table {
				id: ID @primaryKey
				body: String
				route: String @decide(source: "body", values: ["a", "b"])
				urgent: Boolean @decide(source: "route")
			}`,
			/derives from "route"/
		);
	});
});
