'use strict';

const rewire = require('rewire');
const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const fs = require('fs-extra');
const env_mgr = require('../../../utility/environment/environmentManager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const npm_utils = require('../../../utility/npmUtilities');
const config_utils = require('../../../config/configUtils');
const install_components = rewire('../../../components/installComponents');

const fake_components = {
	unit_test_package1: {
		package: 'HarperDB/unit_test_package1',
	},
	unit_test_package2: {
		package: 'HarperDB/unit_test_package2',
	},
	unit_test_package3: {
		package: 'HarperDB/unit_test_package3.tar',
	},
	harperdbTest: {
		package: 'HarperDB',
	},
	unitTest1: {
		package: '@HarperDBtest/unit_test_package4',
	},
	darper_test: {
		package: '@HarperDBtestAgain/unit_test_package5@1.2.3',
	},
	fromurl: {
		package: 'https://www.harperdb.io/apps-test',
	},
	operationsApi: {
		param: false,
	},
};

const fake_installed_package_json = {
	dependencies: {
		unit_test_package2: 'github:HarperDB/unit_test_package2#v2',
		unit_test_package1: 'github:HarperDB/unit_test_package1',
		unit_test_packageA: 'github:HarperDB/unit_test_packageA',
	},
};

describe('Test installApps module', () => {
	const sandbox = sinon.createSandbox();
	let get_config_stub;
	let read_json_stub;
	let install_root_mod_stub;
	let write_file_stub;
	let unlink_stub;
	let ensure_sym_link;
	let ensure_dir;

	before(() => {
		env_mgr.setProperty('rootPath', 'unit-test');
		install_components.__set__('hdb_terms.PACKAGE_ROOT', 'comps/unit/tests');
		read_json_stub = sandbox.stub(fs, 'readJsonSync').returns(fake_installed_package_json);
		get_config_stub = sandbox.stub(config_utils, 'getConfiguration').returns(fake_components);
		install_root_mod_stub = sandbox.stub(npm_utils, 'installAllRootModules');
		write_file_stub = sandbox.stub(fs, 'writeFileSync');
		unlink_stub = sandbox.stub(fs, 'unlinkSync');
		ensure_sym_link = sandbox.stub(fs, 'ensureSymlink');
		ensure_dir = sandbox.stub(fs, 'ensureDirSync');
	});

	beforeEach(() => {
		sandbox.resetHistory();
	});

	after(() => {
		sandbox.restore();
	});

	it('Test if no components installed all are installed', async () => {
		const err = new Error('no file');
		err.code = 'ENOENT';
		read_json_stub.throws(err);
		await install_components();
		expect(write_file_stub.args[0]).to.eql([
			'unit-test/package.json',
			'{\n  "dependencies": {\n    "harperdb": "file:comps/unit/tests",\n    "unit_test_package1": "github:HarperDB/unit_test_package1",\n    "unit_test_package2": "github:HarperDB/unit_test_package2",\n    "unit_test_package3": "file:HarperDB/unit_test_package3.tar",\n    "harperdbTest": "npm:HarperDB",\n    "unitTest1": "npm:@HarperDBtest/unit_test_package4",\n    "darper_test": "npm:@HarperDBtestAgain/unit_test_package5@1.2.3",\n    "fromurl": "https://www.harperdb.io/apps-test"\n  }\n}',
		]);
		expect(install_root_mod_stub.called).to.be.true;
	});

	it('Test more components added to existing dependencies', async () => {
		read_json_stub.returns({
			dependencies: {
				unit_test_package2: 'github:HarperDB/unit_test_package2',
				unit_test_package1: 'github:HarperDB/unit_test_package1',
				unit_test_package3: 'github:HarperDB/unit_test_package3',
			},
		});
		await install_components();
		expect(write_file_stub.args[0]).to.eql([
			'unit-test/package.json',
			'{\n  "dependencies": {\n    "harperdb": "file:comps/unit/tests",\n    "unit_test_package1": "github:HarperDB/unit_test_package1",\n    "unit_test_package2": "github:HarperDB/unit_test_package2",\n    "unit_test_package3": "file:HarperDB/unit_test_package3.tar",\n    "harperdbTest": "npm:HarperDB",\n    "unitTest1": "npm:@HarperDBtest/unit_test_package4",\n    "darper_test": "npm:@HarperDBtestAgain/unit_test_package5@1.2.3",\n    "fromurl": "https://www.harperdb.io/apps-test"\n  }\n}',
		]);
	});

	it('Test component it removed', async () => {
		delete fake_components.fromurl;
		await install_components();
		expect(write_file_stub.args[0]).to.eql([
			'unit-test/package.json',
			'{\n  "dependencies": {\n    "harperdb": "file:comps/unit/tests",\n    "unit_test_package1": "github:HarperDB/unit_test_package1",\n    "unit_test_package2": "github:HarperDB/unit_test_package2",\n    "unit_test_package3": "file:HarperDB/unit_test_package3.tar",\n    "harperdbTest": "npm:HarperDB",\n    "unitTest1": "npm:@HarperDBtest/unit_test_package4",\n    "darper_test": "npm:@HarperDBtestAgain/unit_test_package5@1.2.3"\n  }\n}',
		]);
	});

	it('Test install is not called is there is no change', async () => {
		read_json_stub.returns({
			dependencies: {
				unit_test_package2: 'github:HarperDB/unit_test_package2',
				unit_test_package1: 'github:HarperDB/unit_test_package1',
				unit_test_package3: 'github:HarperDB/unit_test_package3',
			},
		});

		get_config_stub.returns({
			unit_test_package2: {
				package: 'HarperDB/unit_test_package2',
			},
			unit_test_package1: {
				package: 'HarperDB/unit_test_package1',
			},
			unit_test_package3: {
				package: 'HarperDB/unit_test_package3',
			},
		});

		expect(write_file_stub.called).to.be.false;
	});
});
