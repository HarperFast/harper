'use strict';

const rewire = require('rewire');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const fs = require('fs-extra');
const env_mgr = require('../../../utility/environment/environmentManager');
const npm_utils = require('../../../utility/npmUtilities');
const install_apps = rewire('../../../server/customFunctions/installApps');

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
		package: 'HarperDB/unit_test_package3.tar',
		name: 'unit_test_package3',
	},
	{
		package: 'HarperDB',
	},
	{
		package: '@HarperDBtest/unit_test_package4',
	},
	{
		package: '@HarperDBtestAgain/unit_test_package5@1.2.3',
	},
	{
		package: 'https://www.harperdb.io/apps-test',
		name: 'from-url',
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
	const constructAppDep = install_apps.__get__('constructAppDep');
	const constructAppName = install_apps.__get__('constructAppName');
	const getPkgPath = install_apps.__get__('getPkgPath');
	let read_json_stub;
	let install_root_mod_stub;
	let uninstall_root_mod_stub;
	let write_file_stub;
	let move_stub;
	let ensure_sym_link;
	let unlink_stub;
	let readdir_stub;
	let realpath_stub;
	const all_links_fake = [
		{
			name: 'unit_test_package2',
			isSymbolicLink: () => true,
		},
		{
			name: 'unit_test_package3',
			isSymbolicLink: () => true,
		},
	];

	before(() => {
		env_mgr.setProperty('rootPath', 'unit-test');
		env_mgr.setProperty('customFunctions_root', 'unit-test-cf');
		install_root_mod_stub = sandbox.stub(npm_utils, 'installAllRootModules');
		uninstall_root_mod_stub = sandbox.stub(npm_utils, 'uninstallRootModule');
		write_file_stub = sandbox.stub(fs, 'writeFile');
		move_stub = sandbox.stub(fs, 'move');
		ensure_sym_link = sandbox.stub(fs, 'ensureSymlink');
		read_json_stub = sandbox.stub(fs, 'readJson').resolves(fake_installed_package_json);
		unlink_stub = sandbox.stub(fs, 'unlink');
		readdir_stub = sandbox.stub(fs, 'readdir').resolves(all_links_fake);
		realpath_stub = sandbox.stub(fs, 'realpath');
		sandbox.stub(fs, 'ensureDir').resolves();
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
			'{\n  "dependencies": {\n    "unit_test_package1": "HarperDB/unit_test_package1",\n    "unit_test_package2": "HarperDB/unit_test_package2",\n    "unit_test_package3": "HarperDB/unit_test_package3.tar",\n    "HarperDB": "*",\n    "@HarperDBtest/unit_test_package4": "*",\n    "@HarperDBtestAgain/unit_test_package5": "1.2.3",\n    "from-url": "https://www.harperdb.io/apps-test"\n  }\n}',
		]);
		expect(install_root_mod_stub.called).to.be.true;
		expect(ensure_sym_link.called).to.be.true;
		expect(move_stub.args[0]).to.eql([
			'unit-test/package.json',
			'unit-test/installed-packages.json',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(1).args).to.eql([
			'unit-test/node_modules/unit_test_package1',
			'unit-test-cf/unit_test_package1',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(2).args).to.eql([
			'unit-test/node_modules/unit_test_package2',
			'unit-test-cf/unit_test_package2',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(3).args).to.eql([
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
			'{\n  "dependencies": {\n    "unit_test_package1": "HarperDB/unit_test_package1",\n    "unit_test_package2": "HarperDB/unit_test_package2",\n    "unit_test_package3": "HarperDB/unit_test_package3.tar",\n    "HarperDB": "*",\n    "@HarperDBtest/unit_test_package4": "*",\n    "@HarperDBtestAgain/unit_test_package5": "1.2.3",\n    "from-url": "https://www.harperdb.io/apps-test",\n    "unit_test_package4": "HarperDB/unit_test_package4"\n  }\n}',
		]);
		expect(install_root_mod_stub.called).to.be.true;
		expect(ensure_sym_link.called).to.be.true;
		expect(move_stub.args[0]).to.eql([
			'unit-test/package.json',
			'unit-test/installed-packages.json',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(1).args).to.eql([
			'unit-test/node_modules/unit_test_package1',
			'unit-test-cf/unit_test_package1',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(2).args).to.eql([
			'unit-test/node_modules/unit_test_package2',
			'unit-test-cf/unit_test_package2',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(3).args).to.eql([
			'unit-test/node_modules/unit_test_package3',
			'unit-test-cf/unit_test_package3',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(4).args).to.eql([
			'unit-test/node_modules/HarperDB',
			'unit-test-cf/HarperDB',
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
		realpath_stub.onCall(0).resolves('unit-test/node_modules/unit_test_package2');
		realpath_stub.onCall(1).resolves('unit-test/node_modules/unit_test_package22');
		realpath_stub.onCall(2).resolves('unit-test/node_modules/unit_test_package3');
		await install_apps();
		expect(unlink_stub.getCall(0).args[0]).to.equal('unit-test-cf/unit_test_package2');
		expect(unlink_stub.getCall(1).args[0]).to.equal('unit-test-cf/unit_test_package3');
		expect(write_file_stub.args[0]).to.eql([
			'unit-test/package.json',
			'{\n  "dependencies": {\n    "unit_test_package1": "HarperDB/unit_test_package1"\n  }\n}',
		]);
		expect(install_root_mod_stub.called).to.be.true;
		expect(ensure_sym_link.called).to.be.true;
		expect(move_stub.args[0]).to.eql([
			'unit-test/package.json',
			'unit-test/installed-packages.json',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(1).args).to.eql([
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
		expect(ensure_sym_link.called).to.be.true;
		expect(move_stub.args[0]).to.eql([
			'unit-test/package.json',
			'unit-test/installed-packages.json',
			{
				overwrite: true,
			},
		]);
		expect(ensure_sym_link.getCall(1).args).to.eql([
			'unit-test/node_modules/unit_test_package1',
			'unit-test-cf/unit_test_package1',
			{
				overwrite: true,
			},
		]);
	});

	it('Test constructAppDep happy path', () => {
		const res_1 = constructAppDep(undefined, '@harperdb/isCool');
		expect(res_1).to.eql({
			dep_name: '@harperdb/isCool',
			version: '*',
		});
		const res_2 = constructAppDep(undefined, 'harperdb');
		expect(res_2).to.eql({
			dep_name: 'harperdb',
			version: '*',
		});
		const res_3 = constructAppDep('dog', 'harperdb@^1.2.3');
		expect(res_3).to.eql({
			dep_name: 'harperdb',
			version: '^1.2.3',
		});
		const res_4 = constructAppDep('dog', '@harperdb/dog@1.2.3');
		expect(res_4).to.eql({
			dep_name: '@harperdb/dog',
			version: '1.2.3',
		});
		const res_5 = constructAppDep('dog', 'HarperDB-Add-Ons/cf-template-websockets');
		expect(res_5).to.eql({
			dep_name: 'dog',
			version: 'HarperDB-Add-Ons/cf-template-websockets',
		});
	});

	it('Test constructAppDep sad path', () => {
		let error;
		try {
			constructAppDep(undefined, 'HarperDB-Add-Ons/cf-template-websockets');
		} catch (err) {
			error = err;
		}
		expect(error.message).to.equal("'name' is required for app: HarperDB-Add-Ons/cf-template-websockets");
	});

	it('Test constructAppName happy path', () => {
		const res_1 = constructAppName('HarperDB');
		expect(res_1).to.equal('HarperDB');
		const res_2 = constructAppName('lodash@^4.17.18');
		expect(res_2).to.equal('lodash');
		const res_3 = constructAppName('@fastify/error@2.0.0');
		expect(res_3).to.equal('error');
	});

	it('Test getPkgPath happy path', () => {
		const res_1 = getPkgPath('@fastify/error@2.0.0', 'error', 'unit/test');
		expect(res_1).to.equal('unit/test/node_modules/@fastify/error');
		const res_2 = getPkgPath('HarperDB-Add-Ons/cf-template-websockets', 'dogs', 'unit/test');
		expect(res_2).to.equal('unit/test/node_modules/dogs');
	});
});
