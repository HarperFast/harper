'use strict';

const rewire = require('rewire');
const schema_meta_validator = rewire('../../validation/schemaMetadataValidator');
const assert = require('assert');

const FAKE_SCHEMA = {
	dev: {
		dog: {
			id: 'cool-id',
			name: 'dog',
			hash_attribute: 'id',
			schema: 'schema',
		},
	},
};
// we don't use hdb_schema anymore
describe.skip('test checkSchemaExists function', () => {
	it('test describeSchema throws an error', async () => {
		global.hdb_schema = {};
		let schema_describe_rw = schema_meta_validator.__set__('schemaDescribe', {
			describeSchema: async (describe_schema_object) => {
				throw Error('bad stuff');
			},
		});

		let message = await schema_meta_validator.checkSchemaExists('prod');

		assert.deepStrictEqual(message, "Schema 'prod' does not exist");
		schema_describe_rw();
	});

	it('test describeSchema fetches the schema', async () => {
		global.hdb_schema = {};
		let schema_describe_rw = schema_meta_validator.__set__('schemaDescribe', {
			describeSchema: async (describe_schema_object) => {
				return FAKE_SCHEMA.dev;
			},
		});

		let message = await schema_meta_validator.checkSchemaExists('dev');

		assert.deepStrictEqual(message, undefined);
		assert.deepStrictEqual(global.hdb_schema['dev'], FAKE_SCHEMA.dev);
		schema_describe_rw();
	});
});
// we don't use hdb_schema anymore
describe.skip('test checkSchemaTableExists', () => {
	it('test describeSchema returns message', async () => {
		let check_schema_rw = schema_meta_validator.__set__('checkSchemaExists', async (schema_name) => {
			return `Schema '${schema_name}' does not exist`;
		});

		let message = await schema_meta_validator.checkSchemaTableExists('prod', 'dog');
		assert.deepStrictEqual(message, "Schema 'prod' does not exist");
		check_schema_rw();
	});

	it('test describeTable errors', async () => {
		global.hdb_schema = {};
		let schema_describe_rw = schema_meta_validator.__set__('schemaDescribe', {
			describeSchema: async (describe_schema_object) => {
				return FAKE_SCHEMA.dev;
			},
			describeTable: async (describe_object) => {
				throw Error('fail');
			},
		});

		let message = await schema_meta_validator.checkSchemaTableExists('dev', 'breed');
		assert.deepStrictEqual(message, "Table 'dev.breed' does not exist");
		assert.deepStrictEqual(global.hdb_schema['dev'], FAKE_SCHEMA.dev);

		schema_describe_rw();
	});

	it('test describeTable returns nothing', async () => {
		global.hdb_schema = {};
		let schema_describe_rw = schema_meta_validator.__set__('schemaDescribe', {
			describeSchema: async (describe_schema_object) => {
				return FAKE_SCHEMA.dev;
			},
			describeTable: async (describe_object) => {},
		});

		let message = await schema_meta_validator.checkSchemaTableExists('dev', 'breed');
		assert.deepStrictEqual(message, "Table 'dev.breed' does not exist");
		assert.deepStrictEqual(global.hdb_schema['dev'], FAKE_SCHEMA.dev);

		schema_describe_rw();
	});

	it('test describeTable returns the table', async () => {
		global.hdb_schema = {};
		let breed_table = {
			id: 'cooler-id',
			name: 'breed',
			schema: 'dev',
			hash_attribute: 'breed_id',
		};
		let schema_describe_rw = schema_meta_validator.__set__('schemaDescribe', {
			describeSchema: async (describe_schema_object) => {
				return FAKE_SCHEMA.dev;
			},
			describeTable: async (describe_object) => {
				return breed_table;
			},
		});

		let message = await schema_meta_validator.checkSchemaTableExists('dev', 'breed');
		assert.deepStrictEqual(message, undefined);
		assert.deepStrictEqual(global.hdb_schema['dev']['breed'], breed_table);

		schema_describe_rw();
	});
});
