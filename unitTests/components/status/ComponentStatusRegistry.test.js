const assert = require('node:assert/strict');
const sinon = require('sinon');
const { ComponentStatusRegistry } = require('../../../components/status/ComponentStatusRegistry.ts');
const { ComponentStatus } = require('../../../components/status/ComponentStatus.ts');
const { COMPONENT_STATUS_LEVELS } = require('../../../components/status/types.ts');
const { StatusAggregator } = require('../../../components/status/crossThread.ts');
const itcModule = require('../../../server/threads/itc.js');
const manageThreadsModule = require('../../../server/threads/manageThreads.js');

describe('ComponentStatusRegistry', function() {
	let registry;
	let clock;

	beforeEach(function() {
		registry = new ComponentStatusRegistry();
		clock = sinon.useFakeTimers();

		// Stub ITC functions
		sinon.stub(itcModule, 'sendItcEvent').resolves();
		sinon.stub(manageThreadsModule, 'onMessageByType');
		sinon.stub(manageThreadsModule, 'getWorkerIndex').returns(0);
	});

	afterEach(function() {
		clock.restore();
		sinon.restore();
		// Reset the registry to ensure clean state
		registry.reset();
	});

	after(function() {
		// Clean up any environment variables that might have been set
		delete process.env.COMPONENT_STATUS_TIMEOUT;
	});

	describe('reset', function() {
		it('should clear all statuses', function() {
			registry.setStatus('comp1', 'healthy', 'All good');
			registry.setStatus('comp2', 'error', 'Failed');
			
			registry.reset();
			
			assert.equal(registry.getStatus('comp1'), undefined);
			assert.equal(registry.getStatus('comp2'), undefined);
			assert.equal(registry.getAllStatuses().size, 0);
		});
	});

	describe('setStatus', function() {
		it('should set component status with all parameters', function() {
			const error = new Error('Test error');
			registry.setStatus('database', 'error', 'Connection failed', error);
			
			const status = registry.getStatus('database');
			assert.ok(status instanceof ComponentStatus);
			assert.equal(status.status, 'error');
			assert.equal(status.message, 'Connection failed');
			assert.equal(status.error, error);
		});

		it('should set component status without optional parameters', function() {
			registry.setStatus('cache', 'healthy');
			
			const status = registry.getStatus('cache');
			assert.equal(status.status, 'healthy');
			assert.equal(status.message, undefined);
			assert.equal(status.error, undefined);
		});

		it('should overwrite existing status', function() {
			registry.setStatus('api', 'loading', 'Starting up');
			registry.setStatus('api', 'healthy', 'Ready');
			
			const status = registry.getStatus('api');
			assert.equal(status.status, 'healthy');
			assert.equal(status.message, 'Ready');
		});

		it('should throw error for invalid component name', function() {
			assert.throws(
				() => registry.setStatus('', 'healthy'),
				{
					name: 'ComponentStatusOperationError',
					message: /Component name must be a non-empty string/
				}
			);

			assert.throws(
				() => registry.setStatus(null, 'healthy'),
				{
					name: 'ComponentStatusOperationError',
					message: /Component name must be a non-empty string/
				}
			);
		});

		it('should throw error for invalid status level', function() {
			assert.throws(
				() => registry.setStatus('comp4', 'invalid-status'),
				{
					name: 'ComponentStatusOperationError',
					message: /Invalid status level: invalid-status/
				}
			);
		});
	});

	describe('getStatus', function() {
		it('should return undefined for non-existent component', function() {
			assert.equal(registry.getStatus('non-existent'), undefined);
		});

		it('should return ComponentStatus instance', function() {
			registry.setStatus('test', 'healthy');
			const status = registry.getStatus('test');
			
			assert.ok(status instanceof ComponentStatus);
		});
	});

	describe('getAllStatuses', function() {
		it('should return empty map initially', function() {
			const statuses = registry.getAllStatuses();
			assert.ok(statuses instanceof Map);
			assert.equal(statuses.size, 0);
		});

		it('should return all registered statuses', function() {
			registry.setStatus('comp1', 'healthy');
			registry.setStatus('comp2', 'warning', 'High memory');
			registry.setStatus('comp3', 'error', 'Failed');
			
			const statuses = registry.getAllStatuses();
			assert.equal(statuses.size, 3);
			assert.ok(statuses.has('comp1'));
			assert.ok(statuses.has('comp2'));
			assert.ok(statuses.has('comp3'));
		});
	});

	describe('reportHealthy', function() {
		it('should set status to healthy with message', function() {
			registry.reportHealthy('service', 'Running smoothly');
			
			const status = registry.getStatus('service');
			assert.equal(status.status, COMPONENT_STATUS_LEVELS.HEALTHY);
			assert.equal(status.message, 'Running smoothly');
		});

		it('should set status to healthy without message', function() {
			registry.reportHealthy('service');
			
			const status = registry.getStatus('service');
			assert.equal(status.status, COMPONENT_STATUS_LEVELS.HEALTHY);
		});
	});

	describe('reportError', function() {
		it('should set status to error with Error object', function() {
			const error = new Error('Connection timeout');
			registry.reportError('database', error, 'DB connection failed');
			
			const status = registry.getStatus('database');
			assert.equal(status.status, COMPONENT_STATUS_LEVELS.ERROR);
			assert.equal(status.message, 'DB connection failed');
			assert.equal(status.error, error);
		});

		it('should set status to error with string error', function() {
			registry.reportError('api', 'Invalid configuration');
			
			const status = registry.getStatus('api');
			assert.equal(status.status, COMPONENT_STATUS_LEVELS.ERROR);
			assert.equal(status.error, 'Invalid configuration');
		});
	});

	describe('reportWarning', function() {
		it('should set status to warning with message', function() {
			registry.reportWarning('cache', 'Cache size approaching limit');
			
			const status = registry.getStatus('cache');
			assert.equal(status.status, COMPONENT_STATUS_LEVELS.WARNING);
			assert.equal(status.message, 'Cache size approaching limit');
		});
	});

	describe('lifecycle management methods', function() {
		describe('initializeLoading', function() {
			it('should set status to loading with custom message', function() {
				registry.initializeLoading('auth', 'Connecting to auth server');
				
				const status = registry.getStatus('auth');
				assert.equal(status.status, COMPONENT_STATUS_LEVELS.LOADING);
				assert.equal(status.message, 'Connecting to auth server');
			});

			it('should set status to loading with default message', function() {
				registry.initializeLoading('auth');
				
				const status = registry.getStatus('auth');
				assert.equal(status.status, COMPONENT_STATUS_LEVELS.LOADING);
				assert.equal(status.message, 'Component is loading');
			});
		});

		describe('markLoaded', function() {
			it('should set status to healthy with custom message', function() {
				registry.markLoaded('storage', 'Storage initialized');
				
				const status = registry.getStatus('storage');
				assert.equal(status.status, COMPONENT_STATUS_LEVELS.HEALTHY);
				assert.equal(status.message, 'Storage initialized');
			});

			it('should set status to healthy with default message', function() {
				registry.markLoaded('storage');
				
				const status = registry.getStatus('storage');
				assert.equal(status.status, COMPONENT_STATUS_LEVELS.HEALTHY);
				assert.equal(status.message, 'Component loaded successfully');
			});
		});

		describe('markFailed', function() {
			it('should set status to error with all parameters', function() {
				const error = new Error('Init failed');
				registry.markFailed('logger', error, 'Failed to initialize logger');
				
				const status = registry.getStatus('logger');
				assert.equal(status.status, COMPONENT_STATUS_LEVELS.ERROR);
				assert.equal(status.message, 'Failed to initialize logger');
				assert.equal(status.error, error);
			});

			it('should set status to error with string error', function() {
				registry.markFailed('logger', 'Configuration missing');
				
				const status = registry.getStatus('logger');
				assert.equal(status.status, COMPONENT_STATUS_LEVELS.ERROR);
				assert.equal(status.error, 'Configuration missing');
			});
		});
	});


	describe('getComponentsByStatus', function() {
		beforeEach(function() {
			registry.setStatus('comp1', 'healthy');
			registry.setStatus('comp2', 'error', 'Failed');
			registry.setStatus('comp3', 'healthy');
			registry.setStatus('comp4', 'warning', 'Degraded');
			registry.setStatus('comp5', 'error', 'Timeout');
		});

		it('should return components with specific status', function() {
			const healthyComponents = registry.getComponentsByStatus(COMPONENT_STATUS_LEVELS.HEALTHY);
			assert.equal(healthyComponents.length, 2);
			assert.equal(healthyComponents[0].name, 'comp1');
			assert.equal(healthyComponents[1].name, 'comp3');
		});

		it('should return empty array for status with no components', function() {
			const loadingComponents = registry.getComponentsByStatus(COMPONENT_STATUS_LEVELS.LOADING);
			assert.equal(loadingComponents.length, 0);
		});

		it('should return correct component objects', function() {
			const errorComponents = registry.getComponentsByStatus(COMPONENT_STATUS_LEVELS.ERROR);
			assert.equal(errorComponents.length, 2);
			
			const comp2 = errorComponents.find(c => c.name === 'comp2');
			assert.ok(comp2);
			assert.equal(comp2.status.message, 'Failed');
			
			const comp5 = errorComponents.find(c => c.name === 'comp5');
			assert.ok(comp5);
			assert.equal(comp5.status.message, 'Timeout');
		});
	});

	describe('getStatusSummary', function() {
		it('should return initial summary with zero counts', function() {
			const summary = registry.getStatusSummary();
			
			assert.equal(summary[COMPONENT_STATUS_LEVELS.HEALTHY], 0);
			assert.equal(summary[COMPONENT_STATUS_LEVELS.ERROR], 0);
			assert.equal(summary[COMPONENT_STATUS_LEVELS.WARNING], 0);
			assert.equal(summary[COMPONENT_STATUS_LEVELS.LOADING], 0);
			assert.equal(summary[COMPONENT_STATUS_LEVELS.UNKNOWN], 0);
		});

		it('should count components by status', function() {
			registry.setStatus('comp1', 'healthy');
			registry.setStatus('comp2', 'healthy');
			registry.setStatus('comp3', 'error');
			registry.setStatus('comp4', 'warning');
			registry.setStatus('comp5', 'error');
			registry.setStatus('comp6', 'loading');
			
			const summary = registry.getStatusSummary();
			
			assert.equal(summary[COMPONENT_STATUS_LEVELS.HEALTHY], 2);
			assert.equal(summary[COMPONENT_STATUS_LEVELS.ERROR], 2);
			assert.equal(summary[COMPONENT_STATUS_LEVELS.WARNING], 1);
			assert.equal(summary[COMPONENT_STATUS_LEVELS.LOADING], 1);
			assert.equal(summary[COMPONENT_STATUS_LEVELS.UNKNOWN], 0);
		});
	});

	// Test aggregate functionality through getAggregatedFromAllThreads
	describe('aggregation functionality (via getAggregatedFromAllThreads)', function() {
		it('should aggregate single component from multiple threads', function() {
			const allStatuses = new Map([
				['myComponent@main', {
					status: 'healthy',
					lastChecked: new Date(1000),
					message: 'Main thread healthy'
				}],
				['myComponent@worker-1', {
					status: 'healthy',
					lastChecked: new Date(2000),
					message: 'Worker 1 healthy'
				}],
				['myComponent@worker-2', {
					status: 'healthy',
					lastChecked: new Date(3000),
					message: 'Worker 2 healthy'
				}]
			]);
			
			const aggregated = StatusAggregator.aggregate(allStatuses);
			
			assert.equal(aggregated.size, 1);
			const aggStatus = aggregated.get('myComponent');
			assert.ok(aggStatus);
			assert.equal(aggStatus.componentName, 'myComponent');
			assert.equal(aggStatus.status, 'healthy');
			assert.equal(aggStatus.lastChecked.main, 1000);
			assert.equal(aggStatus.lastChecked.workers[1], 2000);
			assert.equal(aggStatus.lastChecked.workers[2], 3000);
			assert.equal(aggStatus.abnormalities, undefined); // All healthy, no abnormalities
		});

		it('should detect abnormalities when statuses differ', function() {
			const allStatuses = new Map([
				['database@worker-0', {
					status: 'healthy',
					lastChecked: new Date(1000),
					message: 'Worker 0 healthy'
				}],
				['database@worker-1', {
					status: 'error',
					lastChecked: new Date(2000),
					message: 'Connection failed',
					error: 'Timeout'
				}],
				['database@worker-2', {
					status: 'healthy',
					lastChecked: new Date(3000),
					message: 'Worker 2 healthy'
				}]
			]);
			
			const aggregated = StatusAggregator.aggregate(allStatuses);
			const aggStatus = aggregated.get('database');
			
			assert.equal(aggStatus.status, 'error'); // Error takes priority
			assert.ok(aggStatus.abnormalities);
			assert.equal(aggStatus.abnormalities.size, 2); // Two healthy threads are abnormal
			
			// Check abnormality details
			const worker0Abnormality = aggStatus.abnormalities.get('database@worker-0');
			assert.ok(worker0Abnormality);
			assert.equal(worker0Abnormality.status, 'healthy');
			assert.equal(worker0Abnormality.workerIndex, -1); // No workerIndex in input
		});

		it('should prioritize non-healthy messages', function() {
			const allStatuses = new Map([
				['api@worker-0', {
					status: 'healthy',
					lastChecked: new Date(3000), // Most recent
					message: 'All systems operational'
				}],
				['api@worker-1', {
					status: 'warning',
					lastChecked: new Date(2000),
					message: 'High latency detected'
				}],
				['api@worker-2', {
					status: 'healthy',
					lastChecked: new Date(1000),
					message: 'Running normally'
				}]
			]);
			
			const aggregated = StatusAggregator.aggregate(allStatuses);
			const aggStatus = aggregated.get('api');
			
			assert.equal(aggStatus.status, 'warning');
			assert.equal(aggStatus.latestMessage, 'High latency detected'); // Non-healthy message preferred
		});

		it('should handle status priority correctly', function() {
			const testCases = [
				{ statuses: ['healthy', 'healthy', 'healthy'], expected: 'healthy' },
				{ statuses: ['healthy', 'unknown', 'healthy'], expected: 'unknown' },
				{ statuses: ['healthy', 'loading', 'unknown'], expected: 'loading' },
				{ statuses: ['healthy', 'warning', 'loading'], expected: 'warning' },
				{ statuses: ['healthy', 'error', 'warning'], expected: 'error' },
			];
			
			for (const testCase of testCases) {
				const statuses = new Map();
				testCase.statuses.forEach((status, i) => {
					statuses.set(`comp@worker-${i}`, {
						status,
						lastChecked: new Date(i * 1000)
					});
				});
				
				const aggregated = StatusAggregator.aggregate(statuses);
				const aggStatus = aggregated.get('comp');
				assert.equal(aggStatus.status, testCase.expected);
			}
		});

		it('should handle worker index in status data', function() {
			const allStatuses = new Map([
				['service@worker-1', {
					status: 'error',
					lastChecked: new Date(1000),
					message: 'Failed',
					workerIndex: 1
				}],
				['service@worker-2', {
					status: 'healthy',
					lastChecked: new Date(2000),
					message: 'OK',
					workerIndex: 2
				}]
			]);
			
			const aggregated = StatusAggregator.aggregate(allStatuses);
			const aggStatus = aggregated.get('service');
			
			// Check abnormality has correct workerIndex
			const abnormality = aggStatus.abnormalities.get('service@worker-2');
			assert.equal(abnormality.workerIndex, 2);
		});

		it('should handle main thread correctly', function() {
			const allStatuses = new Map([
				['logger@main', {
					status: 'healthy',
					lastChecked: new Date(1000),
					message: 'Main thread logger OK'
				}],
				['logger@worker-0', {
					status: 'healthy',
					lastChecked: new Date(2000),
					message: 'Worker 0 logger OK'
				}]
			]);
			
			const aggregated = StatusAggregator.aggregate(allStatuses);
			const aggStatus = aggregated.get('logger');
			
			assert.equal(aggStatus.lastChecked.main, 1000);
			assert.equal(aggStatus.lastChecked.workers[0], 2000);
		});
	});


	describe('static getAggregatedFromAllThreads method', function() {
		it('should collect and aggregate statuses', async function() {
			// Mock the crossThreadCollector to avoid actual ITC communication
			const { crossThreadCollector } = require('../../../components/status/crossThread.ts');
			const originalCollect = crossThreadCollector.collect;

			// Create a fresh registry for this test
			const testRegistry = new ComponentStatusRegistry();
			testRegistry.setStatus('sharedComp', 'healthy');

			// Mock the collector to return local statuses only
			crossThreadCollector.collect = async () => {
				return new Map([
					['sharedComp@main', {
						status: 'healthy',
						lastChecked: new Date(),
						message: 'Local component healthy'
					}]
				]);
			};

			try {
				const aggregated = await ComponentStatusRegistry.getAggregatedFromAllThreads(testRegistry);

				// Should have aggregated the local status only
				assert.equal(aggregated.size, 1);
				const aggStatus = aggregated.get('sharedComp');
				assert.ok(aggStatus);
				assert.equal(aggStatus.componentName, 'sharedComp');
				assert.equal(aggStatus.status, 'healthy');
				assert.equal(aggStatus.abnormalities, undefined); // No abnormalities with single thread
			} finally {
				// Restore original collector
				crossThreadCollector.collect = originalCollect;
				testRegistry.reset();
			}
		});
	});

	describe('getAggregatedStatusFor method', function() {
		describe('basic aggregation scenarios', function() {
			it('should return status for exact component match only', async function() {
				const consolidatedStatuses = new Map([
					['application-template', {
						componentName: 'application-template',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'Application loaded successfully',
						lastChecked: { workers: { 0: 1000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('application-template', consolidatedStatuses);

				assert.equal(result.status, COMPONENT_STATUS_LEVELS.HEALTHY);
				assert.equal(result.message, 'All components loaded successfully');
				assert.equal(result.details, undefined);
				assert.deepEqual(result.lastChecked, { workers: { 0: 1000 } });
			});

			it('should return aggregated status for sub-components only', async function() {
				const consolidatedStatuses = new Map([
					['application-template.rest', {
						componentName: 'application-template.rest',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'REST component loaded',
						lastChecked: { workers: { 0: 1000 } }
					}],
					['application-template.static', {
						componentName: 'application-template.static',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'Static component loaded',
						lastChecked: { workers: { 0: 2000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('application-template', consolidatedStatuses);

				assert.equal(result.status, COMPONENT_STATUS_LEVELS.HEALTHY);
				assert.equal(result.message, 'All components loaded successfully');
				assert.equal(result.details, undefined);
				assert.deepEqual(result.lastChecked, { workers: { 0: 1000 } });
			});

			it('should combine exact match with sub-components', async function() {
				const consolidatedStatuses = new Map([
					['application-template', {
						componentName: 'application-template',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'Main application healthy',
						lastChecked: { workers: { 0: 1000 } }
					}],
					['application-template.rest', {
						componentName: 'application-template.rest',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'REST component healthy',
						lastChecked: { workers: { 0: 2000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('application-template', consolidatedStatuses);

				assert.equal(result.status, COMPONENT_STATUS_LEVELS.HEALTHY);
				assert.equal(result.message, 'All components loaded successfully');
				assert.equal(result.details, undefined);
				assert.deepEqual(result.lastChecked, { workers: { 0: 1000 } });
			});

			it('should return unknown status when component not found', async function() {
				const consolidatedStatuses = new Map([
					['other-component', {
						componentName: 'other-component',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'Other component healthy',
						lastChecked: { workers: { 0: 1000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('missing-component', consolidatedStatuses);

				assert.equal(result.status, COMPONENT_STATUS_LEVELS.UNKNOWN);
				assert.equal(result.message, 'The component has not been loaded yet (may need a restart)');
				assert.deepEqual(result.lastChecked, { workers: {} });
			});
		});

		describe('status priority and aggregation logic', function() {
			it('should prioritize error over other statuses', async function() {
				const consolidatedStatuses = new Map([
					['app.component1', {
						componentName: 'app.component1',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'Component 1 healthy',
						lastChecked: { workers: { 0: 1000 } }
					}],
					['app.component2', {
						componentName: 'app.component2',
						status: COMPONENT_STATUS_LEVELS.ERROR,
						latestMessage: 'Component 2 failed',
						lastChecked: { workers: { 0: 2000 } }
					}],
					['app.component3', {
						componentName: 'app.component3',
						status: COMPONENT_STATUS_LEVELS.LOADING,
						latestMessage: 'Component 3 loading',
						lastChecked: { workers: { 0: 3000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('app', consolidatedStatuses);

				assert.equal(result.status, COMPONENT_STATUS_LEVELS.ERROR);
				assert.ok(result.message.includes('app.component2: Component 2 failed'));
				assert.ok(result.details);
				assert.equal(result.details['app.component2'].status, COMPONENT_STATUS_LEVELS.ERROR);
			});

			it('should prioritize loading over healthy statuses', async function() {
				const consolidatedStatuses = new Map([
					['service.api', {
						componentName: 'service.api',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'API healthy',
						lastChecked: { workers: { 0: 1000 } }
					}],
					['service.database', {
						componentName: 'service.database',
						status: COMPONENT_STATUS_LEVELS.LOADING,
						latestMessage: 'Database connecting',
						lastChecked: { workers: { 0: 2000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('service', consolidatedStatuses);

				assert.equal(result.status, COMPONENT_STATUS_LEVELS.LOADING);
				assert.ok(result.message.includes('service.database: Database connecting'));
				assert.ok(result.details);
				assert.equal(result.details['service.database'].status, COMPONENT_STATUS_LEVELS.LOADING);
			});

			it('should return healthy when all components healthy', async function() {
				const consolidatedStatuses = new Map([
					['webapp.frontend', {
						componentName: 'webapp.frontend',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'Frontend ready',
						lastChecked: { workers: { 0: 1000 } }
					}],
					['webapp.backend', {
						componentName: 'webapp.backend',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'Backend ready',
						lastChecked: { workers: { 0: 2000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('webapp', consolidatedStatuses);

				assert.equal(result.status, COMPONENT_STATUS_LEVELS.HEALTHY);
				assert.equal(result.message, 'All components loaded successfully');
				assert.equal(result.details, undefined);
			});

			it('should handle mixed status scenarios correctly', async function() {
				const consolidatedStatuses = new Map([
					['mixed', {
						componentName: 'mixed',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'Main component healthy',
						lastChecked: { workers: { 0: 1000 } }
					}],
					['mixed.sub1', {
						componentName: 'mixed.sub1',
						status: COMPONENT_STATUS_LEVELS.ERROR,
						latestMessage: 'Sub component 1 failed',
						lastChecked: { workers: { 0: 2000 } }
					}],
					['mixed.sub2', {
						componentName: 'mixed.sub2',
						status: COMPONENT_STATUS_LEVELS.LOADING,
						latestMessage: 'Sub component 2 loading',
						lastChecked: { workers: { 0: 3000 } }
					}],
					['mixed.sub3', {
						componentName: 'mixed.sub3',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'Sub component 3 healthy',
						lastChecked: { workers: { 0: 4000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('mixed', consolidatedStatuses);

				// Error should take priority
				assert.equal(result.status, COMPONENT_STATUS_LEVELS.ERROR);

				// Message should include both error and loading components
				assert.ok(result.message.includes('mixed.sub1: Sub component 1 failed'));
				assert.ok(result.message.includes('mixed.sub2: Sub component 2 loading'));

				// Details should include non-healthy components
				assert.ok(result.details);
				assert.equal(result.details['mixed.sub1'].status, COMPONENT_STATUS_LEVELS.ERROR);
				assert.equal(result.details['mixed.sub2'].status, COMPONENT_STATUS_LEVELS.LOADING);
				assert.equal(result.details['mixed.sub3'], undefined); // Healthy component not in details
			});
		});

		describe('details and message generation', function() {
			it('should include details when components have issues', async function() {
				const consolidatedStatuses = new Map([
					['app.good', {
						componentName: 'app.good',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'Working fine',
						lastChecked: { workers: { 0: 1000 } }
					}],
					['app.bad', {
						componentName: 'app.bad',
						status: COMPONENT_STATUS_LEVELS.ERROR,
						latestMessage: 'Database connection failed',
						lastChecked: { workers: { 0: 2000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('app', consolidatedStatuses);

				assert.ok(result.details);
				assert.equal(Object.keys(result.details).length, 1);
				assert.equal(result.details['app.bad'].status, COMPONENT_STATUS_LEVELS.ERROR);
				assert.equal(result.details['app.bad'].message, 'Database connection failed');
				assert.equal(result.details['app.good'], undefined); // Healthy components not included
			});

			it('should not include details when all components healthy', async function() {
				const consolidatedStatuses = new Map([
					['service.web', {
						componentName: 'service.web',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'Web server ready',
						lastChecked: { workers: { 0: 1000 } }
					}],
					['service.api', {
						componentName: 'service.api',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'API ready',
						lastChecked: { workers: { 0: 2000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('service', consolidatedStatuses);

				assert.equal(result.details, undefined);
				assert.equal(result.message, 'All components loaded successfully');
			});

			it('should generate descriptive messages for problem components', async function() {
				const consolidatedStatuses = new Map([
					['system.auth', {
						componentName: 'system.auth',
						status: COMPONENT_STATUS_LEVELS.ERROR,
						latestMessage: 'Authentication server timeout',
						lastChecked: { workers: { 0: 1000 } }
					}],
					['system.cache', {
						componentName: 'system.cache',
						status: COMPONENT_STATUS_LEVELS.LOADING,
						latestMessage: 'Redis connecting',
						lastChecked: { workers: { 0: 2000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('system', consolidatedStatuses);

				// Message should include both components with their specific messages
				const expectedMessage = 'system.auth: Authentication server timeout; system.cache: Redis connecting';
				assert.equal(result.message, expectedMessage);
			});

			it('should format component keys correctly in messages', async function() {
				const consolidatedStatuses = new Map([
					['my-app.long-component-name', {
						componentName: 'my-app.long-component-name',
						status: COMPONENT_STATUS_LEVELS.ERROR,
						latestMessage: 'Component failed initialization',
						lastChecked: { workers: { 0: 1000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('my-app', consolidatedStatuses);

				assert.ok(result.message.includes('my-app.long-component-name: Component failed initialization'));
			});
		});

		describe('edge cases and error handling', function() {
			it('should handle empty consolidated statuses gracefully', async function() {
				const consolidatedStatuses = new Map();

				const result = await registry.getAggregatedStatusFor('any-component', consolidatedStatuses);

				assert.equal(result.status, COMPONENT_STATUS_LEVELS.UNKNOWN);
				assert.equal(result.message, 'The component has not been loaded yet (may need a restart)');
				assert.deepEqual(result.lastChecked, { workers: {} });
			});

			it('should handle null/undefined consolidated statuses', async function() {
				// Mock the static method to avoid cross-thread communication in tests
				const originalMethod = ComponentStatusRegistry.getAggregatedFromAllThreads;
				ComponentStatusRegistry.getAggregatedFromAllThreads = async () => new Map();

				try {
					// Test with null
					let result = await registry.getAggregatedStatusFor('test-component', null);
					assert.equal(result.status, COMPONENT_STATUS_LEVELS.UNKNOWN);

					// Test with undefined
					result = await registry.getAggregatedStatusFor('test-component', undefined);
					assert.equal(result.status, COMPONENT_STATUS_LEVELS.UNKNOWN);
				} finally {
					// Restore original method
					ComponentStatusRegistry.getAggregatedFromAllThreads = originalMethod;
				}
			});

			it('should work with pre-provided consolidated statuses', async function() {
				const consolidatedStatuses = new Map([
					['provided.test', {
						componentName: 'provided.test',
						status: COMPONENT_STATUS_LEVELS.HEALTHY,
						latestMessage: 'Pre-provided status',
						lastChecked: { workers: { 0: 1000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('provided', consolidatedStatuses);

				assert.equal(result.status, COMPONENT_STATUS_LEVELS.HEALTHY);
				assert.equal(result.message, 'All components loaded successfully');
			});

			it('should fetch consolidated statuses when not provided', async function() {
				// This test ensures the method works without pre-provided statuses
				// It will attempt to fetch from ComponentStatusRegistry.getAggregatedFromAllThreads
				registry.setStatus('test-fetch', COMPONENT_STATUS_LEVELS.HEALTHY, 'Local component');

				// Mock the static method to return our local status
				const originalMethod = ComponentStatusRegistry.getAggregatedFromAllThreads;
				ComponentStatusRegistry.getAggregatedFromAllThreads = async () => {
					return new Map([
						['test-fetch', {
							componentName: 'test-fetch',
							status: COMPONENT_STATUS_LEVELS.HEALTHY,
							latestMessage: 'Fetched status',
							lastChecked: { workers: { 0: 1000 } }
						}]
					]);
				};

				try {
					const result = await registry.getAggregatedStatusFor('test-fetch'); // No consolidatedStatuses provided

					assert.equal(result.status, COMPONENT_STATUS_LEVELS.HEALTHY);
					assert.equal(result.message, 'All components loaded successfully');
				} finally {
					// Restore original method
					ComponentStatusRegistry.getAggregatedFromAllThreads = originalMethod;
				}
			});

			it('should handle missing latestMessage gracefully', async function() {
				const consolidatedStatuses = new Map([
					['no-msg.component', {
						componentName: 'no-msg.component',
						status: COMPONENT_STATUS_LEVELS.ERROR,
						// No latestMessage property
						lastChecked: { workers: { 0: 1000 } }
					}]
				]);

				const result = await registry.getAggregatedStatusFor('no-msg', consolidatedStatuses);

				assert.equal(result.status, COMPONENT_STATUS_LEVELS.ERROR);
				assert.ok(result.message.includes('no-msg.component: error')); // Should fallback to status
			});
		});
	});
});