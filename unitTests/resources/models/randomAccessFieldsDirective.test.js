'use strict';

const assert = require('node:assert/strict');
const { setupTestDBPath } = require('../../testUtils');
const { loadGQLSchema } = require('#src/resources/graphql');
const { tables } = require('#src/resources/databases');

// Parse-level behavior of the @table(randomAccessFields:) directive: the boolean is coerced from the
// GraphQL string value and flows through to the primary store's encoder, which keeps or stubs its
// struct-write hook. storage.randomAccessFields defaults off, so an absent directive leaves writes off.
describe('@table(randomAccessFields:) directive parsing', () => {
	before(() => setupTestDBPath());

	it('enables typed random-access structures when randomAccessFields: true', async () => {
		await loadGQLSchema(`type RafOn @table(randomAccessFields: true) {
			id: ID @primaryKey
			name: String
		}`);
		const encoder = tables.RafOn.primaryStore.encoder;
		assert.equal(encoder.randomAccessStructure, true);
		assert.ok(encoder._writeStruct.length > 0, 'expected the real struct-write hook');
	});

	it('keeps writes disabled when randomAccessFields: false', async () => {
		await loadGQLSchema(`type RafOff @table(randomAccessFields: false) {
			id: ID @primaryKey
			name: String
		}`);
		const encoder = tables.RafOff.primaryStore.encoder;
		assert.ok(!encoder.randomAccessStructure);
		assert.equal(encoder._writeStruct.length, 0, 'expected the no-op write stub');
	});

	it('defaults to disabled when the directive is absent', async () => {
		await loadGQLSchema(`type RafAbsent @table {
			id: ID @primaryKey
			name: String
		}`);
		const encoder = tables.RafAbsent.primaryStore.encoder;
		assert.ok(!encoder.randomAccessStructure);
		assert.equal(encoder._writeStruct.length, 0, 'expected the no-op write stub');
	});
});
