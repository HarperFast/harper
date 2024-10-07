'use strict';

const chai = require('chai');
const { expect } = chai;
const rewire = require('rewire');
const sinon = require('sinon');
const init_paths = require('../../dataLayer/harperBridge/lmdbBridge/lmdbUtility/initializePaths');
const bridge = require('../../dataLayer/harperBridge/harperBridge');
const mount_hdb = rewire('../../utility/mount_hdb');
const path = require('path');
const SEP = path.sep;

describe('test mount_hdb module', () => {
	const sandbox = sinon.createSandbox();
	const mk_dirp_sync_stub = sandbox.stub();
	let init_sys_schema_path_stub;
	let create_table_stub;
	const test_system_schema = {
		cat: {
			hash_attribute: 'cat_id',
			id: '8650f230-be55-4455-8843-55bcfe7f61c4',
			name: 'cat',
			schema: 'test',
			attributes: [
				{
					attribute: 'cat_name',
				},
				{
					attribute: 'cat_id',
				},
			],
		},
		bird: {
			hash_attribute: 'bird_id',
			id: '8650f230-be55-4455-8843-55bcfe7f61c4',
			name: 'bird',
			schema: 'test',
			attributes: [
				{
					attribute: 'bird_id',
				},
				{
					attribute: 'bird_age',
				},
			],
		},
	};

	before(() => {
		init_sys_schema_path_stub = sandbox.stub(init_paths, 'initSystemSchemaPaths').resolves();
		create_table_stub = sandbox.stub(bridge, 'createTable');
		mount_hdb.__set__('mkdirpSync', mk_dirp_sync_stub);
		mount_hdb.__set__('copySync', sandbox.stub());
		mount_hdb.__set__('system_schema', test_system_schema);
	});

	after(() => {
		sandbox.restore();
	});

	it('Test mountHdb calls makeDirectory happy path', async () => {
		const test_hdb_path = `mount${SEP}test${SEP}hdb`;
		await mount_hdb(test_hdb_path);
		expect(mk_dirp_sync_stub.getCall(0).args[0]).to.equal(`mount${SEP}test${SEP}hdb`);
		expect(mk_dirp_sync_stub.getCall(1).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}backup`);
		expect(mk_dirp_sync_stub.getCall(2).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}keys`);
		expect(mk_dirp_sync_stub.getCall(3).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}keys${SEP}.license`);
		expect(mk_dirp_sync_stub.getCall(4).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}log`);
		expect(mk_dirp_sync_stub.getCall(5).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}database`);
		expect(mk_dirp_sync_stub.getCall(6).args[0]).to.equal(`mount${SEP}test${SEP}hdb${SEP}components`);
	});

	it('Test createLMDBTables happy path', async () => {
		const createLMDBTables = mount_hdb.__get__('createLMDBTables');
		await createLMDBTables();
		expect(init_sys_schema_path_stub.getCall(0).args).to.eql(['system', 'cat']);
		expect(init_sys_schema_path_stub.getCall(1).args).to.eql(['system', 'bird']);
		expect(create_table_stub.getCall(0).args).to.eql([
			'cat',
			{
				schema: 'system',
				table: 'cat',
				hash_attribute: 'cat_id',
				attributes: [
					{
						attribute: 'cat_name',
					},
					{
						attribute: 'cat_id',
						isPrimaryKey: true,
					},
				],
			},
		]);
		expect(create_table_stub.getCall(1).args).to.eql([
			'bird',
			{
				schema: 'system',
				table: 'bird',
				hash_attribute: 'bird_id',
				attributes: [
					{
						attribute: 'bird_id',
						isPrimaryKey: true,
					},
					{
						attribute: 'bird_age',
					},
				],
			},
		]);
	});
});
