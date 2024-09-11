'use strict';

const chai = require('chai');
const sinon = require('sinon');
const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('path');
const tar = require('tar-fs');
const test_util = require('../../test_utils');
test_util.getMockTestPath();
const operations = rewire('../../../components/operations');
const env = require('../../../utility/environment/environmentManager');
const { TEST_DATA_BASE64_CF_PROJECT } = require('../../test_data');
const { expect } = chai;
const assert = require('assert');

describe('Test custom functions operations', () => {
	let sandbox = sinon.createSandbox();
	let CF_DIR_ROOT = path.resolve(__dirname, 'custom_functions');
	let TMP_DIR = path.resolve(__dirname, '../../envDir/tmp');
	let SSH_DIR = path.resolve(__dirname, '../../envDir/ssh');

	before(() => {
		fs.removeSync(CF_DIR_ROOT);
		fs.ensureDirSync(CF_DIR_ROOT);
		fs.ensureDirSync(TMP_DIR);
		env.initTestEnvironment();
	});

	after(() => {
		fs.removeSync(CF_DIR_ROOT);
		fs.removeSync(TMP_DIR);
		fs.removeSync(SSH_DIR);
		sandbox.restore();
	});

	it('Test initial cf status values', async () => {
		const { port, directory } = await operations.customFunctionsStatus();

		expect(port).to.exist;
		expect(directory).to.equal(CF_DIR_ROOT);
	});

	it('Test addComponent creates the project folder with the correct name', async () => {
		const response = await operations.addComponent({ project: 'unit_test' });

		expect(response.message).to.equal('Successfully added project: unit_test');
	});

	it('Test getCustomFunctions returns object with proper length and content', async () => {
		const endpoints = await operations.getCustomFunctions();

		const projectName = Object.keys(endpoints)[0];

		expect(endpoints).to.be.instanceOf(Object);
		expect(Object.keys(endpoints)).to.have.length(1);
		expect(projectName).to.equal('unit_test');
		expect(endpoints[projectName]).to.be.instanceOf(Object);
		expect(Object.keys(endpoints[projectName])).to.have.length(2);
		expect(Object.keys(endpoints[projectName])).to.include('routes');
		expect(endpoints[projectName].routes).to.be.instanceOf(Array);
		expect(Object.keys(endpoints[projectName])).to.include('helpers');
		expect(endpoints[projectName].helpers).to.be.instanceOf(Array);
	});

	it('Test packageCustomFunctionProject properly tars up a project directory', async () => {
		const tar_spy = sinon.spy(tar, 'pack');
		const response = await operations.packageComponent({ project: 'unit_test', skip_node_modules: true });

		expect(response).to.be.instanceOf(Object);

		expect(Object.keys(response)).to.have.length(2);
		expect(Object.keys(response)).to.include('project');
		expect(Object.keys(response)).to.include('payload');

		expect(response.project).to.equal('unit_test');

		expect(tar_spy.args[0][1].hasOwnProperty('ignore')).to.be.true;
	}).timeout(5000);

	it('Test setCustomFunction creates a function file as expected', async () => {
		const response = await operations.setCustomFunction({
			project: 'unit_test',
			type: 'routes',
			file: 'example2',
			function_content: 'example2',
		});

		expect(response.message).to.equal('Successfully updated custom function: example2.js');

		const endpoints = await operations.getCustomFunction({ project: 'unit_test', type: 'routes', file: 'example2' });

		expect(endpoints).to.contain('example2');
	});

	it('Test setCustomFunction updates a function file as expected', async () => {
		const response = await operations.setCustomFunction({
			project: 'unit_test',
			type: 'routes',
			file: 'example2',
			function_content: 'example3',
		});

		expect(response.message).to.equal('Successfully updated custom function: example2.js');

		const endpoints = await operations.getCustomFunction({ project: 'unit_test', type: 'routes', file: 'example2' });

		expect(endpoints).to.contain('example3');
	});

	it('Test dropCustomFunctionProject drops project as expected', async () => {
		const response = await operations.dropCustomFunctionProject({ project: 'unit_test' });

		expect(response.message).to.equal('Successfully deleted project: unit_test');

		const endpoints = await operations.getCustomFunctions();

		expect(endpoints).to.be.instanceOf(Object);
		expect(Object.keys(endpoints)).to.have.length(0);
	});

	describe('Test component operations', () => {
		const test_yaml_string =
			"REST: true\ngraphqlSchema:\n  files: '*.graphql'\n  # path: / # exported queries are on the root path by default\n\n";

		async function createMockComponents() {
			await fs.ensureFile(path.join(CF_DIR_ROOT, 'my-cool-component', 'resources.js'));
			await fs.ensureFile(path.join(CF_DIR_ROOT, 'my-cool-component', '.hidden'));
			await fs.ensureFile(path.join(CF_DIR_ROOT, 'my-cool-component', 'utils', 'utils.js'));
			await fs.outputFile(path.join(CF_DIR_ROOT, 'my-other-component', 'config.yaml'), test_yaml_string);
		}

		before(async () => {
			await createMockComponents();
		});

		it('Test getComponents happy path', async () => {
			const result = await operations.getComponents();
			expect(result.name).to.equal('custom_functions');
			expect(result.entries[0].name).to.equal('my-cool-component');
			expect(result.entries[0].entries.length).to.equal(2);
			expect(result.entries[1].name).to.equal('my-other-component');
			expect(result.entries[1].entries[0].name).to.equal('config.yaml');
		});

		it('Test getComponentFile happy path', async () => {
			const result = await operations.getComponentFile({ project: 'my-other-component', file: 'config.yaml' });
			expect(result.message).to.eql(test_yaml_string);
		});

		it('Test setComponentFile happy path', async () => {
			const result = await operations.setComponentFile({
				project: 'my-other-component',
				file: 'config.yaml',
				payload: 'im the new payload',
			});
			const updated_file = await operations.getComponentFile({ project: 'my-other-component', file: 'config.yaml' });
			expect(updated_file.message).to.eql('im the new payload');
			expect(result.message).to.equal('Successfully set component: config.yaml');
		});
	});

	describe('Test ssh key operations', () => {
		it('Test ssh key operations happy path', async () => {
			// Nothing should exist before keys are added
			let result = await operations.listSSHKeys({});
			expect(result).to.eql([]);
			result = await operations.getSSHKnownHosts({});
			expect(result).to.eql({ known_hosts: null });

			// Add a non-github.com key
			result = await operations.addSSHKey({
				name: 'testkey1',
				key: 'random\nstring',
				host: 'testkey1.gitlab.com',
				hostname: 'gitlab.com',
				known_hosts: 'gitlab.com fake1\ngitlab.com fake2',
			});
			expect(result.message).to.eql(`Added ssh key: testkey1`);

			// List SSH Keys and get the known hosts
			result = await operations.listSSHKeys({});
			expect(result).to.eql([{ name: 'testkey1' }]);
			result = await operations.getSSHKnownHosts({});
			expect(result).to.eql({ known_hosts: 'gitlab.com fake1\ngitlab.com fake2' });

			// Add a github.com key
			result = await operations.addSSHKey({
				name: 'testkey2',
				key: 'random\nstring',
				host: 'testkey2.github.com',
				hostname: 'github.com',
			});
			expect(result.message).to.eql('Added ssh key: testkey2');

			// List SSH Keys and get the known_hosts
			result = await operations.listSSHKeys({});
			expect(result).to.eql([{ name: 'testkey1' }, { name: 'testkey2' }]);
			result = await operations.getSSHKnownHosts({});
			// It should have the 2 added from the first key + some more from github
			expect(result.known_hosts.split('\n').length).is.greaterThan(2);

			//update
			result = await operations.updateSSHKey({ name: 'testkey2', key: 'different\nrandom\nstring' });
			expect(result.message).to.eql('Updated ssh key: testkey2');

			//delete
			result = await operations.deleteSSHKey({ name: 'testkey2' });
			expect(result.message).to.eql('Deleted ssh key: testkey2');

			//list/get
			result = await operations.listSSHKeys({});
			expect(result).to.eql([{ name: 'testkey1' }]);
		});

		it('Test ssh key operations errors', async () => {
			let error;
			try {
				await operations.updateSSHKey({ name: 'nonexistant', key: 'anything' });
			} catch (err) {
				error = err;
			}
			expect(error.message).to.eql('Key does not exist. Use add_ssh_key');

			try {
				await operations.deleteSSHKey({ name: 'nonexistant' });
			} catch (err) {
				error = err;
			}
			expect(error.message).to.eql('Key does not exist');

			await operations.addSSHKey({ name: 'duplicate', key: 'key', host: 'test', hostname: 'github.com' });
			try {
				await operations.addSSHKey({ name: 'duplicate', key: 'key', host: 'test', hostname: 'github.com' });
			} catch (err) {
				error = err;
			}
			expect(error.message).to.eql('Key already exists. Use update_ssh_key or delete_ssh_key and then add_ssh_key');
		});
	});
});
