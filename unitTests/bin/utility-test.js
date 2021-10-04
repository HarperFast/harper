'use strict';

const env_mangr = require('../../utility/environment/environmentManager');
env_mangr.initTestEnvironment();
const PropertiesReader = require('properties-reader');
const chai = require('chai');
const { expect } = chai;
const utility = require('../../bin/utility');
const settings_test_file = require('../settingsTestFile');

describe('test utility.changeSettingsFile function', () => {
	before(() => {
		settings_test_file.buildFile();
	});

	after(() => {
		settings_test_file.deleteFile();
	});

	it('test no env/cmd vars expect bak to be same as settings', () => {
		let error;
		try {
			utility.changeSettingsFile();
		} catch (e) {
			error = e;
		}
		expect(error).to.equal(undefined);
		let props = PropertiesReader(settings_test_file.getSettingsFilePath());
		let props_bak = PropertiesReader(settings_test_file.getSettingsFileBakPath());

		expect(props.getAllProperties()).to.deep.eql(props_bak.getAllProperties());
	});

	it('test setting a varibale that does not exist for settings', () => {
		let error;
		process.env['COOL_SETTING'] = 'rad';
		try {
			utility.changeSettingsFile();
		} catch (e) {
			error = e;
		}
		expect(error).to.equal(undefined);
		let props = PropertiesReader(settings_test_file.getSettingsFilePath());
		let props_bak = PropertiesReader(settings_test_file.getSettingsFileBakPath());

		expect(props.get('COOL_SETTING')).to.eql(null);
		expect(props.getAllProperties()).to.deep.eql(props_bak.getAllProperties());
	});

	it('test passing new settings expect bak to be orig & new file to have new settings', () => {
		let props_orig = PropertiesReader(settings_test_file.getSettingsFilePath());

		let error;

		process.argv.push('--NODE_NAME');
		process.argv.push('cool_node');
		process.argv.push('--CLUSTERING_PORT');
		process.argv.push('');
		process.env['SERVER_TIMEOUT_MS'] = 3;
		process.env['MAX_HDB_PROCESSES'] = 1;
		process.env['NODE_NAME'] = '';
		try {
			utility.changeSettingsFile();
		} catch (e) {
			error = e;
		}
		expect(error).to.equal(undefined);
		let props = PropertiesReader(settings_test_file.getSettingsFilePath());

		expect(props.get('SERVER_TIMEOUT_MS')).to.equal(3);
		expect(props.get('MAX_HDB_PROCESSES')).to.equal(1);
		expect(props.get('NODE_NAME')).to.equal('cool_node');
		expect(props.get('CLUSTERING_PORT')).to.equal('');

		let props_bak = PropertiesReader(settings_test_file.getSettingsFileBakPath());

		expect(props_orig.getAllProperties()).to.deep.eql(props_bak.getAllProperties());

		process.argv.splice(process.argv.length - 4, 4);
		delete process.env['SERVER_TIMEOUT_MS'];
		delete process.env['MAX_HDB_PROCESSES'];
		delete process.env['NODE_NAME'];
	});
});
