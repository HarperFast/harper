'use strict';

const rewire = require('rewire');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const fs = require('fs-extra');
const env_mgr = require('../../../utility/environment/environmentManager');
const npm_utils = require('../../../utility/npmUtilities');
const install_apps = require('../../../apps/installApps');

const fake_apps = [
	{
		package: 'HarperDB/unit_test_package1',
		name: 'unit_test_package1',
	},
	{
		package: 'HarperDB/unit_test_package2',
		name: 'unit_test_package2',
	},
	{
		package: 'HarperDB/unit_test_package3',
		name: 'unit_test_package3',
	},
];

const fake_installed_package_json = {
	dependencies: {
		unit_test_package2: 'HarperDB/unit_test_package2#v2',
		unit_test_package1: 'HarperDB/unit_test_package1',
		unit_test_packageA: 'HarperDB/unit_test_packageA',
	},
};

describe('Test installApps module', () => {
	const sandbox = sinon.createSandbox();
	let read_json_stub;
	let install_root_mod_stub;
	let uninstall_root_mod_stub;
	let write_file_stub;
	let link_harperdb_stub;
	let move_stub;
	let ensure_sym_link;
	let unlink_stub;

	before(() => {
		env_mgr.setProperty('rootPath', 'unit-test');
		env_mgr.setProperty('customFunctions_root', 'unit-test-cf');
		install_root_mod_stub = sandbox.stub(npm_utils, 'installAllRootModules');
		uninstall_root_mod_stub = sandbox.stub(npm_utils, 'uninstallRootModule');
		write_file_stub = sandbox.stub(fs, 'writeFile');
		link_harperdb_stub = sandbox.stub(npm_utils, 'linkHarperdb');
		move_stub = sandbox.stub(fs, 'move');
		ensure_sym_link = sandbox.stub(fs, 'ensureSymlink');
		read_json_stub = sandbox.stub(fs, 'readJson').resolves(fake_installed_package_json);
		unlink_stub = sandbox.stub(fs, 'unlink');
	});

	beforeEach(() => {
		sandbox.resetHistory();
		env_mgr.setProperty('apps', fake_apps);
	});

	after(() => {
		sandbox.restore();
	});

	it('Test if no apps installed all apps are installed', async () => {
		const err = new Error('no file');
		err.code = 'ENOENT';
		read_json_stub.throws(err);
		await install_apps();
		expect(write_file_stub.args[0]).to.eql([
			'unit-test/package.json',
			'{\n  "dependencies": {\n    "unit_test_package1": "HarperDB/unit_test_package1",\n    "unit_test_package2": "HarperDB/unit_test_package2",\n    "unit_test_package3": "HarperDB/unit_test_package3"\n  }\n}',
		]);
		expect(install_root_mod_stub.called).to.be.true;
		expect(link_harperdb_stub.called).to.be.true;
		expect(move_stub.args[0]).to.eql([
			'unit-test/package.json',
			'unit-test/installed-packages.json',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(0).args).to.eql([
			'unit-test/node_modules/unit_test_package1',
			'unit-test-cf/unit_test_package1',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(1).args).to.eql([
			'unit-test/node_modules/unit_test_package2',
			'unit-test-cf/unit_test_package2',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(2).args).to.eql([
			'unit-test/node_modules/unit_test_package3',
			'unit-test-cf/unit_test_package3',
			{
				overwrite: true,
			},
		]);
	});

	it('Test some apps are installed and wanting to install one more', async () => {
		read_json_stub.resolves({
			dependencies: {
				unit_test_package2: 'HarperDB/unit_test_package2',
				unit_test_package1: 'HarperDB/unit_test_package1',
				unit_test_package3: 'HarperDB/unit_test_package3',
			},
		});

		fake_apps.push({
			package: 'HarperDB/unit_test_package4',
			name: 'unit_test_package4',
		});
		env_mgr.setProperty('apps', fake_apps);
		await install_apps();
		expect(write_file_stub.args[0]).to.eql([
			'unit-test/package.json',
			'{\n  "dependencies": {\n    "unit_test_package1": "HarperDB/unit_test_package1",\n    "unit_test_package2": "HarperDB/unit_test_package2",\n    "unit_test_package3": "HarperDB/unit_test_package3",\n    "unit_test_package4": "HarperDB/unit_test_package4"\n  }\n}',
		]);
		expect(install_root_mod_stub.called).to.be.true;
		expect(link_harperdb_stub.called).to.be.true;
		expect(move_stub.args[0]).to.eql([
			'unit-test/package.json',
			'unit-test/installed-packages.json',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(0).args).to.eql([
			'unit-test/node_modules/unit_test_package1',
			'unit-test-cf/unit_test_package1',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(1).args).to.eql([
			'unit-test/node_modules/unit_test_package2',
			'unit-test-cf/unit_test_package2',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(2).args).to.eql([
			'unit-test/node_modules/unit_test_package3',
			'unit-test-cf/unit_test_package3',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(3).args).to.eql([
			'unit-test/node_modules/unit_test_package4',
			'unit-test-cf/unit_test_package4',
			{
				overwrite: true,
			},
		]);
		fake_apps.pop();
	});

	it('Test an app is removed', async () => {
		read_json_stub.resolves({
			dependencies: {
				unit_test_package2: 'HarperDB/unit_test_package2',
				unit_test_package1: 'HarperDB/unit_test_package1',
				unit_test_package3: 'HarperDB/unit_test_package3',
			},
		});

		const two_fake_app = [
			{
				package: 'HarperDB/unit_test_package1',
				name: 'unit_test_package1',
			},
		];
		env_mgr.setProperty('apps', two_fake_app);
		await install_apps();
		expect(uninstall_root_mod_stub.getCall(0).args[0]).to.equal('HarperDB/unit_test_package2');
		expect(uninstall_root_mod_stub.getCall(1).args[0]).to.equal('HarperDB/unit_test_package3');
		expect(unlink_stub.getCall(0).args[0]).to.equal('unit-test-cf/unit_test_package2');
		expect(unlink_stub.getCall(1).args[0]).to.equal('unit-test-cf/unit_test_package3');
		expect(write_file_stub.args[0]).to.eql([
			'unit-test/package.json',
			'{\n  "dependencies": {\n    "unit_test_package1": "HarperDB/unit_test_package1"\n  }\n}',
		]);
		expect(install_root_mod_stub.called).to.be.true;
		expect(link_harperdb_stub.called).to.be.true;
		expect(move_stub.args[0]).to.eql([
			'unit-test/package.json',
			'unit-test/installed-packages.json',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(0).args).to.eql([
			'unit-test/node_modules/unit_test_package1',
			'unit-test-cf/unit_test_package1',
			{
				overwrite: true,
			},
		]);
	});

	it('Test an app is updated if its tag changes', async () => {
		read_json_stub.resolves({
			dependencies: {
				unit_test_package1: 'HarperDB/unit_test_package1',
			},
		});

		const one_fake_app = [
			{
				package: 'HarperDB/unit_test_package1#2',
				name: 'unit_test_package1',
			},
		];

		env_mgr.setProperty('apps', one_fake_app);
		await install_apps();
		expect(write_file_stub.args[0]).to.eql([
			'unit-test/package.json',
			'{\n  "dependencies": {\n    "unit_test_package1": "HarperDB/unit_test_package1#2"\n  }\n}',
		]);
		expect(install_root_mod_stub.called).to.be.true;
		expect(link_harperdb_stub.called).to.be.true;
		expect(move_stub.args[0]).to.eql([
			'unit-test/package.json',
			'unit-test/installed-packages.json',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(0).args).to.eql([
			'unit-test/node_modules/unit_test_package1',
			'unit-test-cf/unit_test_package1',
			{
				overwrite: true,
			},
		]);
	});
});
