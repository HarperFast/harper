'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const rewire = require('rewire');
const fs = require('fs-extra');
const env_mgr = require('../../../../../utility/environment/environmentManager');
const hdb_terms = require('../../../../../utility/hdbTerms');
const init_paths = rewire('../../../../../data_layer/harperBridge/lmdbBridge/lmdbUtility/initializePaths');

describe('Test initializePaths module', () => {
	const test_base_path = '/init/paths/test';
	const test_schemas_config = {
		init_paths_schema_test: {
			tables: {
				init_path_table: {
					path: test_base_path,
				},
			},
		},
		init_paths_schema_test_a: {
			tables: {
				init_path_table: {
					auditPath: '/test/table/auditPath',
				},
			},
		},
		init_paths_schema_test_b: {
			path: '/test/just/schema/path',
		},
	};
	let sandbox;
	let get_hdb_base_path_stub;

	before(() => {
		init_paths.__set__('BASE_SCHEMA_PATH', undefined);
		init_paths.__set__('SYSTEM_SCHEMA_PATH', undefined);
		init_paths.__set__('TRANSACTION_STORE_PATH', undefined);
		sandbox = sinon.createSandbox();
		get_hdb_base_path_stub = sandbox.stub(env_mgr, 'getHdbBasePath').returns(test_base_path);
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.STORAGE_PATH, undefined);
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.STORAGE_AUDIT_PATH, undefined);
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.SCHEMAS, test_schemas_config);
	});

	after(() => {
		sandbox.restore();
		env_mgr.setProperty(hdb_terms.CONFIG_PARAMS.SCHEMAS, undefined);
	});

	it('Test getBaseSchemaPath returns base path', () => {
		const result = init_paths.getBaseSchemaPath();
		expect(result).to.equal('/init/paths/test/schema');
	});

	it('Test getSystemSchemaPath returns system schema path', () => {
		const result = init_paths.getSystemSchemaPath();
		expect(result).to.equal('/init/paths/test/schema/system');
	});

	it('Test getTransactionAuditStoreBasePath returns base audit store path', () => {
		const result = init_paths.getTransactionAuditStorePath('cow');
		expect(result).to.equal('/init/paths/test/transactions/cow');
	});

	it('Test getTransactionAuditStorePath auditPath when table is defined', () => {
		const result = init_paths.getTransactionAuditStorePath('init_paths_schema_test_a', 'init_path_table');
		expect(result).to.equal('/test/table/auditPath');
	});

	it('Test getSchemaPath when table is undefined', () => {
		const result = init_paths.getSchemaPath('init_paths_schema_test');
		expect(result).to.equal('/init/paths/test/schema/init_paths_schema_test');
	});

	it('Test getSchemaPath when table is defined', () => {
		const result = init_paths.getSchemaPath('init_paths_schema_test', 'init_path_table');
		expect(result).to.equal(test_base_path);
	});

	it('Test getSchemaPath when table is defined path for just schema exists', () => {
		const result = init_paths.getSchemaPath('init_paths_schema_test_b', 'init_path_table');
		expect(result).to.equal('/test/just/schema/path');
	});

	it('Test initSystemSchemaPaths sets env props for system tables', () => {
		process.env.SCHEMAS = JSON.stringify([
			{
				system: {
					tables: { coolcat: { path: '/init_path/test_location/cool-cat' } },
				},
			},
			{ system: { path: '/init_path/test_location/system' } },
		]);
		let result = init_paths.initSystemSchemaPaths('system', 'coolcat');
		expect(result).to.equal('/init_path/test_location/cool-cat');

		result = init_paths.initSystemSchemaPaths('system', 'uncool_cat');
		expect(result).to.equal('/init_path/test_location/system');

		const test_schemas_env = env_mgr.get(hdb_terms.CONFIG_PARAMS.SCHEMAS);
		expect(test_schemas_env).to.eql({
			init_paths_schema_test: {
				tables: {
					init_path_table: {
						path: '/init/paths/test',
					},
				},
			},
			init_paths_schema_test_a: {
				tables: {
					init_path_table: {
						auditPath: '/test/table/auditPath',
					},
				},
			},
			init_paths_schema_test_b: {
				path: '/test/just/schema/path',
			},
			system: {
				tables: {
					coolcat: {
						path: '/init_path/test_location/cool-cat',
					},
				},
				path: '/init_path/test_location/system',
			},
		});

		delete process.env.SCHEMAS;
	});

	it('Test initSystemSchemaPaths works when STORAGE_PATH env is set', () => {
		const fs_stub = sandbox.stub(fs, 'mkdirsSync');
		const fs_exists = sandbox.stub(fs, 'pathExistsSync').returns(true);
		process.env.STORAGE_PATH = '/im/a/path/for/testing';
		const result = init_paths.initSystemSchemaPaths('system', 'coolcat');

		expect(result).to.equal('/im/a/path/for/testing/system');
		expect(env_mgr.get(hdb_terms.CONFIG_PARAMS.STORAGE_PATH)).to.equal('/im/a/path/for/testing');

		fs_stub.restore();
		fs_exists.restore();
		delete process.env.STORAGE_PATH;
	});
});
