'use strict';

const chai = require('chai');
const sinon = require('sinon');
const rewire = require('rewire');
const fs = require('fs-extra');
const path = require('path');
const tar = require('tar-fs');
const testUtils = require('../../testUtils.js');
testUtils.getMockTestPath();
const operations = rewire('#js/components/operations');
const env = require('#js/utility/environment/environmentManager');
const { expect } = chai;
const configUtils = require('#js/config/configUtils');

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

	describe('Test custom function project operations', () => {
		let prepareApplicationStub;

		before(() => {
			// Mock prepareApplication to avoid network calls to GitHub template
			prepareApplicationStub = sandbox.stub().resolves();
			operations.__set__('prepareApplication', prepareApplicationStub);
		});

		after(() => {
			// Clean up the unit_test project if it exists
			fs.removeSync(path.join(CF_DIR_ROOT, 'unit_test'));
		});

		it('Test addComponent creates the project folder with the correct name', async () => {
			const response = await operations.addComponent({ project: 'unit_test' });

			expect(response.message).to.equal('Successfully added project: unit_test');
			expect(prepareApplicationStub.calledOnce).to.be.true;
			expect(fs.existsSync(path.join(CF_DIR_ROOT, 'unit_test'))).to.be.true;
		});

		it('Test getCustomFunctions returns object with proper length and content', async () => {
			// Create the expected folder structure that addComponent would have created
			const projectDir = path.join(CF_DIR_ROOT, 'unit_test');
			fs.ensureDirSync(path.join(projectDir, 'routes'));
			fs.ensureDirSync(path.join(projectDir, 'helpers'));

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
			tar_spy.restore();
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
	});

	describe('Test component operations', () => {
		const test_yaml_string =
			"REST: true\ngraphqlSchema:\n  files: '*.graphql'\n  # path: / # exported queries are on the root path by default\n\n";

		async function createMockComponents() {
			await fs.ensureFile(path.join(CF_DIR_ROOT, 'my-cool-component', 'resources.js'));
			await fs.ensureFile(path.join(CF_DIR_ROOT, 'my-cool-component', '.hidden'));
			await fs.ensureFile(path.join(CF_DIR_ROOT, 'my-cool-component', 'utils', 'utils.js'));
			await fs.outputFile(path.join(CF_DIR_ROOT, 'my-other-component', 'config.yaml'), test_yaml_string);
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
			// Components are returned in directory listing order which may vary
			const coolComponent = result.entries.find((e) => e.name === 'my-cool-component');
			const otherComponent = result.entries.find((e) => e.name === 'my-other-component');
			expect(coolComponent).to.exist;
			expect(coolComponent.entries.length).to.equal(3);
			expect(coolComponent.package).to.be.undefined;
			expect(otherComponent).to.exist;
			expect(otherComponent.entries.find((e) => e.name === 'config.yaml')).to.exist;
			expect(otherComponent.package).to.equal('@my-org/my-other-component');
		});

		it('Test getComponents includes status information when component status exists', async () => {
			// Import the actual status module and stub its methods
			const statusModule = require('#src/components/status/index');

			// Stub getAggregatedFromAllThreads to return an empty Map (avoids thread communication)
			const getAggregatedFromAllThreadsStub = sinon.stub(
				statusModule.internal.ComponentStatusRegistry,
				'getAggregatedFromAllThreads'
			);
			getAggregatedFromAllThreadsStub.resolves(new Map());

			// Stub getAggregatedStatusFor to return a running status
			const getAggregatedStatusForStub = sinon.stub(
				statusModule.internal.componentStatusRegistry,
				'getAggregatedStatusFor'
			);
			getAggregatedStatusForStub.resolves({
				status: 'running',
				message: 'Component is running normally',
				lastChecked: {
					workers: {
						0: { status: 'running', timestamp: Date.now() },
					},
				},
			});

			try {
				const result = await operations.getComponents();

				// All components should have the mocked running status
				for (const component of result.entries) {
					expect(component.status).to.exist;
					expect(component.status).to.be.an('object');
					expect(component.status.status).to.equal('running');
					expect(component.status.message).to.equal('Component is running normally');
					expect(component.status.lastChecked).to.exist;
					expect(component.status.lastChecked.workers).to.be.an('object');
					expect(component.status.lastChecked.workers[0]).to.exist;
					expect(component.status.lastChecked.workers[0].status).to.equal('running');
				}
			} finally {
				// Restore original methods
				getAggregatedFromAllThreadsStub.restore();
				getAggregatedStatusForStub.restore();
			}
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

		it('Test getComponents handles getAggregatedFromAllThreads error gracefully', async () => {
			// Import the actual status module and stub getAggregatedFromAllThreads to throw
			const statusModule = require('#src/components/status/index');

			// Stub getAggregatedFromAllThreads to throw an error (simulating ITC failure)
			const getAggregatedFromAllThreadsStub = sinon.stub(
				statusModule.internal.ComponentStatusRegistry,
				'getAggregatedFromAllThreads'
			);
			getAggregatedFromAllThreadsStub.rejects(new Error('ITC communication failure'));

			// Stub getAggregatedStatusFor to return unknown status (since consolidatedStatuses will be undefined)
			const getAggregatedStatusForStub = sinon.stub(
				statusModule.internal.componentStatusRegistry,
				'getAggregatedStatusFor'
			);
			getAggregatedStatusForStub.resolves({
				status: 'unknown',
				message: 'The component has not been loaded yet (may need a restart)',
				lastChecked: { workers: {} },
			});

			try {
				const result = await operations.getComponents();

				// Should still return components with unknown status (graceful degradation)
				expect(result.entries).to.exist;
				expect(result.entries.length).to.be.greaterThan(0);

				// Each component should have unknown status due to the ITC failure
				for (const component of result.entries) {
					expect(component.status).to.exist;
					expect(component.status.status).to.equal('unknown');
				}
			} finally {
				// Restore original methods
				getAggregatedFromAllThreadsStub.restore();
				getAggregatedStatusForStub.restore();
			}
		});

		it('Test getComponents passes consolidatedStatuses to getAggregatedStatusFor', async () => {
			// Import the actual status module and stub its methods
			const statusModule = require('#src/components/status/index');

			// Create a mock consolidated statuses map
			const mockConsolidatedStatuses = new Map([
				[
					'my-cool-component',
					{
						componentName: 'my-cool-component',
						status: 'healthy',
						latestMessage: 'Component healthy',
						lastChecked: { workers: { 0: Date.now() } },
					},
				],
			]);

			// Stub getAggregatedFromAllThreads to return the mock map
			const getAggregatedFromAllThreadsStub = sinon.stub(
				statusModule.internal.ComponentStatusRegistry,
				'getAggregatedFromAllThreads'
			);
			getAggregatedFromAllThreadsStub.resolves(mockConsolidatedStatuses);

			// Stub getAggregatedStatusFor to track what arguments it receives
			const getAggregatedStatusForStub = sinon.stub(
				statusModule.internal.componentStatusRegistry,
				'getAggregatedStatusFor'
			);
			getAggregatedStatusForStub.resolves({
				status: 'healthy',
				message: 'All components loaded successfully',
				lastChecked: { workers: { 0: Date.now() } },
			});

			try {
				await operations.getComponents();

				// Verify getAggregatedStatusFor was called with the consolidated statuses
				expect(getAggregatedStatusForStub.called).to.be.true;
				// Each call should have received the consolidatedStatuses as second argument
				for (const call of getAggregatedStatusForStub.getCalls()) {
					expect(call.args[1]).to.equal(mockConsolidatedStatuses);
				}
			} finally {
				// Restore original methods
				getAggregatedFromAllThreadsStub.restore();
				getAggregatedStatusForStub.restore();
			}
		});

		it('Test getComponents handles getAggregatedStatusFor errors gracefully', async () => {
			// Import the actual status module and stub its methods
			const statusModule = require('#src/components/status/index');

			// Stub getAggregatedFromAllThreads to return an empty map
			const getAggregatedFromAllThreadsStub = sinon.stub(
				statusModule.internal.ComponentStatusRegistry,
				'getAggregatedFromAllThreads'
			);
			getAggregatedFromAllThreadsStub.resolves(new Map());

			// Stub getAggregatedStatusFor to throw an error
			const getAggregatedStatusForStub = sinon.stub(
				statusModule.internal.componentStatusRegistry,
				'getAggregatedStatusFor'
			);
			getAggregatedStatusForStub.rejects(new Error('Status lookup failed'));

			try {
				const result = await operations.getComponents();

				// Should still return components even when status lookup fails
				expect(result.entries).to.exist;
				expect(result.entries.length).to.be.greaterThan(0);

				// Components should have undefined or error status when lookup fails
				for (const component of result.entries) {
					// The component should still be returned, status may be undefined
					expect(component.name).to.exist;
				}
			} finally {
				// Restore original methods
				getAggregatedFromAllThreadsStub.restore();
				getAggregatedStatusForStub.restore();
			}
		});

		it('Test getComponents shows different statuses for different components', async () => {
			// Import the actual status module and stub its methods
			const statusModule = require('#src/components/status/index');

			// Stub getAggregatedFromAllThreads to return an empty map
			const getAggregatedFromAllThreadsStub = sinon.stub(
				statusModule.internal.ComponentStatusRegistry,
				'getAggregatedFromAllThreads'
			);
			getAggregatedFromAllThreadsStub.resolves(new Map());

			// Stub getAggregatedStatusFor to return different statuses for different components
			const getAggregatedStatusForStub = sinon.stub(
				statusModule.internal.componentStatusRegistry,
				'getAggregatedStatusFor'
			);
			getAggregatedStatusForStub.callsFake(async (componentName) => {
				if (componentName === 'my-cool-component') {
					return {
						status: 'healthy',
						message: 'Component is healthy',
						lastChecked: { workers: { 0: Date.now() } },
					};
				} else if (componentName === 'my-other-component') {
					return {
						status: 'error',
						message: 'Component failed to load',
						lastChecked: { workers: { 0: Date.now() } },
					};
				}
				return {
					status: 'unknown',
					message: 'Component not found',
					lastChecked: { workers: {} },
				};
			});

			try {
				const result = await operations.getComponents();

				const coolComponent = result.entries.find((e) => e.name === 'my-cool-component');
				const otherComponent = result.entries.find((e) => e.name === 'my-other-component');

				expect(coolComponent).to.exist;
				expect(coolComponent.status.status).to.equal('healthy');
				expect(coolComponent.status.message).to.equal('Component is healthy');

				expect(otherComponent).to.exist;
				expect(otherComponent.status.status).to.equal('error');
				expect(otherComponent.status.message).to.equal('Component failed to load');
			} finally {
				// Restore original methods
				getAggregatedFromAllThreadsStub.restore();
				getAggregatedStatusForStub.restore();
			}
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

	describe('Test deployComponent force flag', () => {
		beforeEach(() => {
			// Reset the stub before each test
			sandbox.restore();
			sandbox = sinon.createSandbox();
		});

		after(() => {
			sandbox.restore();
		});

		it('Test deployComponent allows overwriting existing user component without force flag', async () => {
			// Mock config to return an existing user component (not a core component)
			sandbox.stub(configUtils, 'getConfigObj').returns({
				'existing-component': {
					package: '@org/existing-component',
				},
			});

			// Mock addConfig to prevent actual file writes
			const addConfigStub = sandbox.stub(configUtils, 'addConfig').resolves();

			// Mock prepareApplication to prevent actual installation
			const prepareApplicationStub = sandbox.stub();
			operations.__set__('prepareApplication', prepareApplicationStub);

			// This should work - user components can be overwritten without force
			await operations.deployComponent({
				project: 'existing-component',
				package: '@org/new-package',
			});

			// Verify addConfig was called
			expect(addConfigStub.calledOnce).to.be.true;
			expect(addConfigStub.firstCall.args[0]).to.equal('existing-component');
			expect(addConfigStub.firstCall.args[1].package).to.equal('@org/new-package');

			// Verify prepareApplication was called
			expect(prepareApplicationStub.calledOnce).to.be.true;
		});

		it('Test deployComponent allows deploying new component without force flag', async () => {
			// Mock config to return no existing component
			sandbox.stub(configUtils, 'getConfigObj').returns({});

			// Mock addConfig to prevent actual file writes
			const addConfigStub = sandbox.stub(configUtils, 'addConfig').resolves();

			// Mock prepareApplication to prevent actual installation
			const prepareApplicationStub = sandbox.stub();
			operations.__set__('prepareApplication', prepareApplicationStub);

			// This should work fine - no component exists yet
			await operations.deployComponent({
				project: 'new-component',
				package: '@org/new-package',
			});

			// Verify addConfig was called
			expect(addConfigStub.calledOnce).to.be.true;
			expect(addConfigStub.firstCall.args[0]).to.equal('new-component');

			// Verify prepareApplication was called
			expect(prepareApplicationStub.calledOnce).to.be.true;
		});

		it('Test deployComponent prevents overwriting core component without force flag', async () => {
			// Mock config to return no existing component
			sandbox.stub(configUtils, 'getConfigObj').returns({});

			let error;
			try {
				await operations.deployComponent({
					project: 'graphql',
					package: '@org/user-package',
				});
			} catch (err) {
				error = err;
			}

			expect(error).to.exist;
			expect(error.message).to.include("Cannot deploy component with name 'graphql'");
			expect(error.message).to.include('protected core component name');
			expect(error.message).to.include('Use force: true to overwrite');
			expect(error.statusCode).to.equal(409);
		});

		it('Test deployComponent allows overwriting core component with force flag', async () => {
			// Mock config to return no existing component
			sandbox.stub(configUtils, 'getConfigObj').returns({});

			// Mock addConfig to prevent actual file writes
			const addConfigStub = sandbox.stub(configUtils, 'addConfig').resolves();

			// Mock prepareApplication to prevent actual installation
			const prepareApplicationStub = sandbox.stub();
			operations.__set__('prepareApplication', prepareApplicationStub);

			// This should NOT throw an error because force is true
			await operations.deployComponent({
				project: 'graphql',
				package: '@org/override-package',
				force: true,
			});

			// Verify addConfig was called
			expect(addConfigStub.calledOnce).to.be.true;
			expect(addConfigStub.firstCall.args[0]).to.equal('graphql');
			expect(addConfigStub.firstCall.args[1].package).to.equal('@org/override-package');

			// Verify prepareApplication was called
			expect(prepareApplicationStub.calledOnce).to.be.true;
		});

		it('Test deployComponent prevents overwriting multiple core component names', async () => {
			// Mock config to return no existing component
			sandbox.stub(configUtils, 'getConfigObj').returns({});

			const coreComponents = ['REST', 'rest', 'graphqlSchema', 'roles', 'authentication', 'http', 'logging', 'mqtt'];

			for (const componentName of coreComponents) {
				let error;
				try {
					await operations.deployComponent({
						project: componentName,
						package: '@org/user-package',
					});
				} catch (err) {
					error = err;
				}

				expect(error).to.exist;
				expect(error.message).to.include(`Cannot deploy component with name '${componentName}'`);
				expect(error.message).to.include('protected core component name');
				expect(error.statusCode).to.equal(409);
			}
		});
	});
});
