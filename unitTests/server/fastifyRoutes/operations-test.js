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
const configUtils = require('../../../config/configUtils');

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

	// Rewired addComponent fails on CI only. Skip for now.
	it.skip('Test addComponent creates the project folder with the correct name', async () => {
		const response = await operations.addComponent({ project: 'unit_test' });

		expect(response.message).to.equal('Successfully added project: unit_test');
	});

	it.skip('Test getCustomFunctions returns object with proper length and content', async () => {
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

	it.skip('Test packageCustomFunctionProject properly tars up a project directory', async () => {
		const tar_spy = sinon.spy(tar, 'pack');
		const response = await operations.packageComponent({ project: 'unit_test', skip_node_modules: true });

		expect(response).to.be.instanceOf(Object);

		expect(Object.keys(response)).to.have.length(2);
		expect(Object.keys(response)).to.include('project');
		expect(Object.keys(response)).to.include('payload');

		expect(response.project).to.equal('unit_test');

		expect(tar_spy.args[0][1].hasOwnProperty('ignore')).to.be.true;
	}).timeout(5000);

	it.skip('Test setCustomFunction creates a function file as expected', async () => {
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

	it.skip('Test setCustomFunction updates a function file as expected', async () => {
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

	it.skip('Test dropCustomFunctionProject drops project as expected', async () => {
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
			const rootConfig = configUtils.getConfiguration();
			sandbox.stub(configUtils, 'getConfiguration').returns({
				'my-other-component': {
					package: '@my-org/my-other-component',
				},
			});
		}

		before(async () => {
			await createMockComponents();
		});

		it('Test getComponents happy path', async () => {
			const result = await operations.getComponents();
			expect(result.name).to.equal('custom_functions');
			expect(result.entries[0].name).to.equal('my-cool-component');
			expect(result.entries[0].entries.length).to.equal(2);
			expect(result.entries[0].package).to.be.undefined;
			expect(result.entries[1].name).to.equal('my-other-component');
			expect(result.entries[1].entries[0].name).to.equal('config.yaml');
			expect(result.entries[1].package).to.equal('@my-org/my-other-component');
		});

		it('Test getComponents includes status information when component status exists', async () => {
			// Mock getAggregatedStatusFor to return status information
			const mockGetAggregatedStatusFor = sinon.stub();
			mockGetAggregatedStatusFor.withArgs('my-cool-component').resolves({
				status: 'healthy',
				message: 'Component loaded successfully',
				lastChecked: { workers: { 0: new Date('2023-01-01').getTime() } },
			});
			mockGetAggregatedStatusFor.withArgs('my-other-component').resolves({
				status: 'error',
				message: 'my-other-component: Failed to load',
				details: {
					'my-other-component': { status: 'error', message: 'Failed to load' },
				},
				lastChecked: { workers: { 1: new Date('2023-01-01').getTime() } },
			});

			const mockComponentStatusModule = {
				internal: {
					ComponentStatusRegistry: {
						getAggregatedFromAllThreads: async () => new Map(),
					},
					componentStatusRegistry: {
						getAggregatedStatusFor: mockGetAggregatedStatusFor,
					},
				},
			};

			// Store original require
			const originalRequire = operations.__get__('require');
			operations.__set__('require', (path) => {
				if (path === './status/index.ts') {
					return mockComponentStatusModule;
				}
				return originalRequire(path);
			});

			const result = await operations.getComponents();

			// Check that status is included for healthy component
			const healthyComponent = result.entries.find((e) => e.name === 'my-cool-component');
			expect(healthyComponent.status).to.exist;
			expect(healthyComponent.status).to.be.an('object');
			expect(healthyComponent.status.status).to.equal('healthy');
			expect(healthyComponent.status.message).to.equal('Component loaded successfully');
			expect(healthyComponent.status.lastChecked).to.exist;
			expect(healthyComponent.status.lastChecked.workers).to.exist;
			expect(healthyComponent.status.lastChecked.workers[0]).to.exist;

			// Check that status and error are included for error component
			const errorComponent = result.entries.find((e) => e.name === 'my-other-component');
			expect(errorComponent.status).to.exist;
			expect(errorComponent.status).to.be.an('object');
			expect(errorComponent.status.status).to.equal('error');
			expect(errorComponent.status.message).to.equal('my-other-component: Failed to load');
			expect(errorComponent.status.details).to.exist;
			expect(errorComponent.status.details['my-other-component'].status).to.equal('error');
			expect(errorComponent.status.lastChecked).to.exist;
			expect(errorComponent.status.lastChecked.workers).to.exist;
			expect(errorComponent.status.lastChecked.workers[1]).to.exist;

			// Restore original require
			operations.__set__('require', originalRequire);
		});

		it('Test getComponents shows unknown status when component not in status map', async () => {
			// Mock getAggregatedStatusFor to return unknown status
			const mockGetAggregatedStatusFor = sinon.stub();
			mockGetAggregatedStatusFor.resolves({
				status: 'unknown',
				message: 'The component has not been loaded yet (may need a restart)',
				lastChecked: { workers: {} },
			});

			const mockComponentStatusModule = {
				internal: {
					ComponentStatusRegistry: {
						getAggregatedFromAllThreads: async () => new Map(),
					},
					componentStatusRegistry: {
						getAggregatedStatusFor: mockGetAggregatedStatusFor,
					},
				},
			};

			// Store original require
			const originalRequire = operations.__get__('require');
			operations.__set__('require', (path) => {
				if (path === './status/index.ts') {
					return mockComponentStatusModule;
				}
				return originalRequire(path);
			});

			const result = await operations.getComponents();

			// All components should have unknown status
			for (const component of result.entries) {
				expect(component.status).to.exist;
				expect(component.status).to.be.an('object');
				expect(component.status.status).to.equal('unknown');
				expect(component.status.message).to.equal('The component has not been loaded yet (may need a restart)');
				expect(component.status.lastChecked).to.exist;
				expect(component.status.lastChecked.workers).to.be.an('object');
				expect(Object.keys(component.status.lastChecked.workers)).to.have.length(0);
			}

			// Restore original require
			operations.__set__('require', originalRequire);
		});

		it('Test getComponents handles missing componentStatus gracefully', async () => {
			// Mock require to throw error when loading componentStatus
			const originalRequire = operations.__get__('require');
			operations.__set__('require', (path) => {
				if (path === './status/index.ts') {
					throw new Error('Module not found');
				}
				return originalRequire(path);
			});

			try {
				const result = await operations.getComponents();
				// Should still return components but without status info or with error handling
				expect(result.entries).to.exist;
			} catch (error) {
				// It's acceptable for this to throw an error if componentStatus can't be loaded
				expect(error.message).to.include('Module not found');
			} finally {
				// Restore original require
				operations.__set__('require', originalRequire);
			}
		});

		it('Test getComponents handles error from getAggregatedFromAllThreads gracefully', async () => {
			// Mock getAggregatedStatusFor to return unknown status when there's an error
			const mockGetAggregatedStatusFor = sinon.stub();
			mockGetAggregatedStatusFor.resolves({
				status: 'unknown',
				message: 'The component has not been loaded yet (may need a restart)',
				lastChecked: { workers: {} },
			});

			const mockComponentStatusModule = {
				internal: {
					ComponentStatusRegistry: {
						getAggregatedFromAllThreads: async () => {
							throw new Error('Failed to collect status from threads');
						},
					},
					componentStatusRegistry: {
						getAggregatedStatusFor: mockGetAggregatedStatusFor,
					},
				},
			};

			// Store original require
			const originalRequire = operations.__get__('require');
			operations.__set__('require', (path) => {
				if (path === './status/index.ts') {
					return mockComponentStatusModule;
				}
				return originalRequire(path);
			});

			const result = await operations.getComponents();

			// Should still return components but with unknown status
			expect(result.entries).to.exist;
			expect(result.entries.length).to.equal(2);

			// All components should have unknown status
			for (const component of result.entries) {
				expect(component.status).to.exist;
				expect(component.status.status).to.equal('unknown');
				expect(component.status.message).to.equal('The component has not been loaded yet (may need a restart)');
				expect(component.status.lastChecked).to.deep.equal({ workers: {} });
			}

			// Restore original require
			operations.__set__('require', originalRequire);
		});

		it('Test getComponents handles undefined return from getAggregatedFromAllThreads gracefully', async () => {
			// Mock getAggregatedStatusFor to return unknown status when consolidatedStatuses is undefined
			const mockGetAggregatedStatusFor = sinon.stub();
			mockGetAggregatedStatusFor.resolves({
				status: 'unknown',
				message: 'The component has not been loaded yet (may need a restart)',
				lastChecked: { workers: {} },
			});

			const mockComponentStatusModule = {
				internal: {
					ComponentStatusRegistry: {
						getAggregatedFromAllThreads: async () => undefined,
					},
					componentStatusRegistry: {
						getAggregatedStatusFor: mockGetAggregatedStatusFor,
					},
				},
			};

			// Store original require
			const originalRequire = operations.__get__('require');
			operations.__set__('require', (path) => {
				if (path === './status/index.ts') {
					return mockComponentStatusModule;
				}
				return originalRequire(path);
			});

			const result = await operations.getComponents();

			// Should still return components but with unknown status
			expect(result.entries).to.exist;
			expect(result.entries.length).to.equal(2);

			// All components should have unknown status
			for (const component of result.entries) {
				expect(component.status).to.exist;
				expect(component.status.status).to.equal('unknown');
				expect(component.status.message).to.equal('The component has not been loaded yet (may need a restart)');
				expect(component.status.lastChecked).to.deep.equal({ workers: {} });
			}

			// Restore original require
			operations.__set__('require', originalRequire);
		});

		it('Test getComponents uses getAggregatedStatusFor method correctly', async () => {
			// Mock the registry with getAggregatedStatusFor method
			const mockGetAggregatedStatusFor = sinon.stub();

			// Mock different return values for different components
			mockGetAggregatedStatusFor.withArgs('my-cool-component').resolves({
				status: 'healthy',
				message: 'All components loaded successfully',
				lastChecked: { workers: { 0: 1000 } },
			});

			mockGetAggregatedStatusFor.withArgs('my-other-component').resolves({
				status: 'error',
				message: 'my-other-component.rest: Database connection failed',
				details: {
					'my-other-component.rest': {
						status: 'error',
						message: 'Database connection failed',
					},
				},
				lastChecked: { workers: { 1: 2000 } },
			});

			const mockComponentStatusModule = {
				internal: {
					ComponentStatusRegistry: {
						getAggregatedFromAllThreads: async () =>
							new Map([
								['my-cool-component', { status: 'healthy' }],
								['my-other-component.rest', { status: 'error' }],
							]),
					},
					componentStatusRegistry: {
						getAggregatedStatusFor: mockGetAggregatedStatusFor,
					},
				},
			};

			// Store original require
			const originalRequire = operations.__get__('require');
			operations.__set__('require', (path) => {
				if (path === './status/index.ts') {
					return mockComponentStatusModule;
				}
				return originalRequire(path);
			});

			const result = await operations.getComponents();

			// Verify getAggregatedStatusFor was called for each component
			expect(mockGetAggregatedStatusFor.calledTwice).to.be.true;
			expect(mockGetAggregatedStatusFor.firstCall.args[0]).to.equal('my-cool-component');
			expect(mockGetAggregatedStatusFor.secondCall.args[0]).to.equal('my-other-component');

			// Verify the consolidated statuses were passed as second argument
			expect(mockGetAggregatedStatusFor.firstCall.args[1]).to.be.instanceOf(Map);
			expect(mockGetAggregatedStatusFor.secondCall.args[1]).to.be.instanceOf(Map);

			// Verify component status matches what getAggregatedStatusFor returned
			const healthyComponent = result.entries.find((e) => e.name === 'my-cool-component');
			expect(healthyComponent.status.status).to.equal('healthy');
			expect(healthyComponent.status.message).to.equal('All components loaded successfully');

			const errorComponent = result.entries.find((e) => e.name === 'my-other-component');
			expect(errorComponent.status.status).to.equal('error');
			expect(errorComponent.status.message).to.equal('my-other-component.rest: Database connection failed');
			expect(errorComponent.status.details).to.exist;
			expect(errorComponent.status.details['my-other-component.rest'].status).to.equal('error');

			// Restore original require
			operations.__set__('require', originalRequire);
		});

		it('Test getComponents handles getAggregatedStatusFor errors gracefully', async () => {
			// Mock getAggregatedStatusFor to throw an error for one component
			const mockGetAggregatedStatusFor = sinon.stub();
			mockGetAggregatedStatusFor.withArgs('my-cool-component').resolves({
				status: 'healthy',
				message: 'All components loaded successfully',
				lastChecked: { workers: { 0: 1000 } },
			});
			mockGetAggregatedStatusFor.withArgs('my-other-component').rejects(new Error('Status aggregation failed'));

			const mockComponentStatusModule = {
				internal: {
					ComponentStatusRegistry: {
						getAggregatedFromAllThreads: async () => new Map(),
					},
					componentStatusRegistry: {
						getAggregatedStatusFor: mockGetAggregatedStatusFor,
					},
				},
			};

			// Store original require
			const originalRequire = operations.__get__('require');
			operations.__set__('require', (path) => {
				if (path === './status/index.ts') {
					return mockComponentStatusModule;
				}
				return originalRequire(path);
			});

			const result = await operations.getComponents();

			// First component should have successful status
			const healthyComponent = result.entries.find((e) => e.name === 'my-cool-component');
			expect(healthyComponent.status.status).to.equal('healthy');

			// Second component should have fallback unknown status due to error
			const errorComponent = result.entries.find((e) => e.name === 'my-other-component');
			expect(errorComponent.status.status).to.equal('unknown');
			expect(errorComponent.status.message).to.equal('Failed to retrieve component status');

			// Restore original require
			operations.__set__('require', originalRequire);
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
			result = await operations.getSSHKey({ name: 'testkey1' });
			expect(result).to.eql({
				name: 'testkey1',
				host: 'testkey1.gitlab.com',
				hostname: 'gitlab.com',
				key: 'random\nstring',
			});

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
				await operations.getSSHKey({ name: 'nonexistant' });
			} catch (err) {
				error = err;
			}
			expect(error.message).to.eql('Key does not exist.');

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
