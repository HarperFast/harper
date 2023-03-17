'use strict';

const chai = require('chai');
const { expect } = chai;
const test_utils = require('../test_utils');
test_utils.preTestPrep();
const path = require('path');
const fs_extra = require('fs-extra');
const fs = require('fs');
const env_mngr = require('../../utility/environment/environmentManager');
const environment_utility = require('../../utility/lmdb/environmentUtility');
const hdb_terms = require('../../utility/hdbTerms');
const system_schema = require('../../json/systemSchema');
const init_paths = require('../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths');
const assert = require('assert');
const rewire = require('rewire');
const sinon = require('sinon');
const rw_mount = rewire('../../utility/mount_hdb');
const SEP = path.sep;
const create_lmdb_tables = rw_mount.__get__('createLMDBTables');
let BASE_BATH;
let BASE_SCHEMA_PATH;
let SYSTEM_SCHEMA_PATH;

describe('test mount_hdb module', () => {
	const sandbox = sinon.createSandbox();
	let init_system_schema_paths_stub;
	let get_schema_path_stub;

	before(async () => {
		BASE_BATH = env_mngr.getHdbBasePath();
		BASE_SCHEMA_PATH = path.join(BASE_BATH, hdb_terms.DATABASES_DIR_NAME);
		SYSTEM_SCHEMA_PATH = path.join(BASE_SCHEMA_PATH, hdb_terms.SYSTEM_SCHEMA_NAME);
		init_system_schema_paths_stub = sandbox.stub(init_paths, 'initSystemSchemaPaths').returns(SYSTEM_SCHEMA_PATH);
		get_schema_path_stub = sandbox.stub(init_paths, 'getSchemaPath').returns(SYSTEM_SCHEMA_PATH);
		await fs_extra.mkdirp(BASE_BATH);
	});

	after(async () => {
		try {
			await fs_extra.remove(BASE_BATH);
		} catch (e) {}
		sandbox.restore();
	});

	it('Test mountHdb function calls makeDirectory with correct params', async () => {
		const test_hdb_path = `mount${SEP}test${SEP}hdb`;
		const make_dir_stub = sandbox.stub();
		const create_lmdb_tables_stub = sandbox.stub();
		const mk_dir_rw = rw_mount.__set__('makeDirectory', make_dir_stub);
		const create_lmdb_table_rw = rw_mount.__set__('createLMDBTables', create_lmdb_tables_stub);
		await rw_mount(test_hdb_path);
		expect(make_dir_stub.getCall(0).args[0]).to.equal(`mount${SEP}test${SEP}hdb`);
		expect(make_dir_stub.getCall(1).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}backup`);
		expect(make_dir_stub.getCall(2).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}trash`);
		expect(make_dir_stub.getCall(3).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}keys`);
		expect(make_dir_stub.getCall(4).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}keys${SEP}.license`);
		expect(make_dir_stub.getCall(5).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}log`);
		expect(make_dir_stub.getCall(6).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}doc`);
		expect(make_dir_stub.getCall(7).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}schema`);
		expect(make_dir_stub.getCall(8).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}schema${SEP}system`);
		expect(make_dir_stub.getCall(9).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}transactions`);
		expect(make_dir_stub.getCall(10).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}clustering${SEP}leaf`);
		expect(create_lmdb_tables_stub.called).to.be.true;
		mk_dir_rw();
		create_lmdb_table_rw();
	});

	it('Test makeDirectory function call mkdirSync as expected', () => {
		const mkdir_sync_stub = sandbox.stub(fs, 'mkdirSync');
		const makeDirectory = rw_mount.__get__('makeDirectory');
		makeDirectory(`mount${SEP}test${SEP}hdb`);
		expect(mkdir_sync_stub.called).to.be.true;
		mkdir_sync_stub.restore();
	});

	describe('test createLMDBTables', () => {
		before(async () => {
			await fs_extra.mkdirp(SYSTEM_SCHEMA_PATH);
			env_mngr.setProperty(hdb_terms.CONFIG_PARAMS.STORAGE_PATH, null); // make sure this isn't set
			init_paths.resetPaths();
		});

		after(async () => {
			try {
				await fs_extra.remove(BASE_SCHEMA_PATH);
			} catch (e) {}
		});

		it('happy path', async () => {
			let err;
			try {
				await create_lmdb_tables(SYSTEM_SCHEMA_PATH);
			} catch (e) {
				err = e;
			}
			assert.deepStrictEqual(err, undefined);

			let tables = Object.keys(system_schema);
			for (let x = 0; x < tables.length; x++) {
				let table_name = tables[x];
				let env;
				let all_dbis;
				let error;
				try {
					env = await environment_utility.openEnvironment(SYSTEM_SCHEMA_PATH, table_name);
					all_dbis = environment_utility.listDBIs(env);
				} catch (e) {
					error = e;
				}
				assert.deepStrictEqual(error, undefined);
				assert.notDeepStrictEqual(env, undefined);
				assert.notDeepStrictEqual(all_dbis, undefined);
				system_schema[table_name].attributes.forEach((attribute) => {
					assert(all_dbis.indexOf(attribute.attribute) >= 0);
				});
			}
		}).timeout(20000);
	});
});
