'use strict';

const assert = require('node:assert');
const { filterArgsAgainstRuntimeConfig } = require('#src/config/harperConfigEnvVars');

describe('filterArgsAgainstRuntimeConfig', function () {
	const ENV_VARS = ['HARPER_SET_CONFIG', 'HARPER_CONFIG', 'HARPER_DEFAULT_CONFIG'];
	let originalEnv;

	beforeEach(function () {
		originalEnv = ENV_VARS.map((name) => process.env[name]);
	});

	afterEach(function () {
		ENV_VARS.forEach((name, i) => {
			if (originalEnv[i] !== undefined) {
				process.env[name] = originalEnv[i];
			} else {
				delete process.env[name];
			}
		});
	});

	describe('Basic filtering', function () {
		it('should return args unchanged when HARPER_SET_CONFIG is not set', function () {
			delete process.env.HARPER_SET_CONFIG;

			const args = {
				operationsapi_network_port: '9925',
				http_port: '9926',
				rootpath: '/var/hdb',
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			assert.deepStrictEqual(result, args, 'Should return all args when HARPER_SET_CONFIG is not set');
		});

		it('should filter out args that are in HARPER_SET_CONFIG', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				operationsApi: {
					network: {
						port: null,
						securePort: 9925,
					},
				},
			});

			const args = {
				operationsapi_network_port: '9925', // Should be filtered
				operationsapi_network_secureport: '9925', // Should be filtered
				http_port: '9926', // Should NOT be filtered
				rootpath: '/var/hdb', // Should NOT be filtered
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			assert.strictEqual(result.operationsapi_network_port, undefined, 'Port should be filtered');
			assert.strictEqual(result.operationsapi_network_secureport, undefined, 'SecurePort should be filtered');
			assert.strictEqual(result.http_port, '9926', 'HTTP port should NOT be filtered');
			assert.strictEqual(result.rootpath, '/var/hdb', 'RootPath should NOT be filtered');
		});

		it('should handle nested config objects', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					port: 8080,
					threads: 4,
				},
				logging: {
					level: 'debug',
				},
			});

			const args = {
				http_port: '9926', // Should be filtered
				http_threads: '2', // Should be filtered
				http_secureport: '9927', // Should NOT be filtered (not in SET_CONFIG)
				logging_level: 'info', // Should be filtered
				rootpath: '/var/hdb', // Should NOT be filtered
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			assert.strictEqual(result.http_port, undefined);
			assert.strictEqual(result.http_threads, undefined);
			assert.strictEqual(result.http_secureport, '9927', 'SecurePort should NOT be filtered');
			assert.strictEqual(result.logging_level, undefined);
			assert.strictEqual(result.rootpath, '/var/hdb');
		});

		it('should be case-insensitive', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				operationsApi: {
					network: {
						port: 9925,
					},
				},
			});

			const args = {
				OPERATIONSAPI_NETWORK_PORT: '9925', // Uppercase - should still be filtered
				operationsapi_network_port: '9925', // Lowercase - should be filtered
				OperationsApi_Network_Port: '9925', // Mixed case - should be filtered
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			assert.strictEqual(Object.keys(result).length, 0, 'All args should be filtered regardless of case');
		});
	});

	describe('Docker Compose scenario', function () {
		it('should filter Dockerfile ENV vars when HARPER_SET_CONFIG overrides them', function () {
			// Simulates the Docker Compose scenario from the bug:
			// Dockerfile has: ENV OPERATIONSAPI_NETWORK_PORT=9925
			// docker-compose.yml has: HARPER_SET_CONFIG with port: null, securePort: 9925

			process.env.HARPER_SET_CONFIG = JSON.stringify({
				operationsApi: {
					network: {
						port: null,
						securePort: 9925,
					},
				},
				http: {
					port: 9926,
					securePort: null,
				},
			});

			// These args come from the Dockerfile ENV vars
			const args = {
				operationsapi_network_port: '9925', // Should be filtered
				http_port: '9926', // Should be filtered
				rootpath: '/var/local/hdb', // Should NOT be filtered
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			// Dockerfile ENV vars for operationsApi.network.port and http.port should be filtered
			assert.strictEqual(result.operationsapi_network_port, undefined, 'Dockerfile port should be filtered');
			assert.strictEqual(result.http_port, undefined, 'Dockerfile http_port should be filtered');
			// But rootpath is not in HARPER_SET_CONFIG, so should remain
			assert.strictEqual(result.rootpath, '/var/local/hdb', 'rootpath should NOT be filtered');
		});
	});

	describe('Edge cases', function () {
		it('should handle empty HARPER_SET_CONFIG', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({});

			const args = {
				http_port: '9926',
				rootpath: '/var/hdb',
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			assert.deepStrictEqual(result, args, 'Should return all args when HARPER_SET_CONFIG is empty');
		});

		it('should handle invalid JSON in HARPER_SET_CONFIG', function () {
			process.env.HARPER_SET_CONFIG = 'not valid json';

			const args = {
				http_port: '9926',
				rootpath: '/var/hdb',
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			// Should return args unchanged and log a warning
			assert.deepStrictEqual(result, args, 'Should return all args when HARPER_SET_CONFIG is invalid JSON');
		});

		it('should handle null values in HARPER_SET_CONFIG', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				operationsApi: {
					network: {
						port: null, // Explicit null
					},
				},
			});

			const args = {
				operationsapi_network_port: '9925', // Should be filtered
				http_port: '9926', // Should NOT be filtered
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			assert.strictEqual(result.operationsapi_network_port, undefined, 'Null value key should still be filtered');
			assert.strictEqual(result.http_port, '9926', 'Other args should NOT be filtered');
		});

		it('should handle arrays in HARPER_SET_CONFIG', function () {
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					corsAccessList: ['http://localhost:3000', 'http://localhost:3001'],
				},
			});

			const args = {
				http_corsaccesslist: 'http://example.com', // Should be filtered
				http_port: '9926', // Should NOT be filtered
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			assert.strictEqual(result.http_corsaccesslist, undefined, 'Array config key should be filtered');
			assert.strictEqual(result.http_port, '9926', 'Other args should NOT be filtered');
		});
	});

	describe('Filters HARPER_CONFIG', function () {
		it('should filter out args that are in HARPER_CONFIG', function () {
			process.env.HARPER_CONFIG = JSON.stringify({
				storage: {
					engine: 'lmdb',
				},
				http: {
					port: 8080,
				},
			});

			const args = {
				storage_engine: 'rocksdb', // Should be filtered
				http_port: '9926', // Should be filtered
				rootpath: '/var/hdb', // Should NOT be filtered
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			assert.strictEqual(result.storage_engine, undefined, 'storage_engine should be filtered by HARPER_CONFIG');
			assert.strictEqual(result.http_port, undefined, 'http_port should be filtered by HARPER_CONFIG');
			assert.strictEqual(result.rootpath, '/var/hdb', 'rootpath should NOT be filtered');
		});

		it('should filter out args that are in either HARPER_CONFIG or HARPER_SET_CONFIG', function () {
			process.env.HARPER_CONFIG = JSON.stringify({
				storage: {
					engine: 'lmdb',
				},
			});
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				http: {
					port: 8080,
				},
			});

			const args = {
				storage_engine: 'rocksdb', // Filtered by HARPER_CONFIG
				http_port: '9926', // Filtered by HARPER_SET_CONFIG
				logging_level: 'info', // NOT filtered
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			assert.strictEqual(result.storage_engine, undefined);
			assert.strictEqual(result.http_port, undefined);
			assert.strictEqual(result.logging_level, 'info');
		});

		it('should filter out legacy CONFIG_PARAM_MAP aliases when canonical key is in HARPER_CONFIG or HARPER_SET_CONFIG', function () {
			process.env.HARPER_CONFIG = JSON.stringify({
				threads: {
					count: 2,
				},
			});
			process.env.HARPER_SET_CONFIG = JSON.stringify({
				operationsApi: {
					network: {
						port: 9925,
					},
				},
			});

			const args = {
				max_http_threads: '8', // Legacy alias for threads_count -> filtered by HARPER_CONFIG
				http_threads: '4', // Legacy alias for threads_count -> filtered by HARPER_CONFIG
				server_port: '9999', // Legacy alias for operationsapi_network_port -> filtered by HARPER_SET_CONFIG
				rootpath: '/var/hdb', // NOT filtered
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			assert.strictEqual(result.max_http_threads, undefined, 'max_http_threads alias should be filtered');
			assert.strictEqual(result.http_threads, undefined, 'http_threads alias should be filtered');
			assert.strictEqual(result.server_port, undefined, 'server_port alias should be filtered');
			assert.strictEqual(result.rootpath, '/var/hdb', 'rootpath should NOT be filtered');
		});
	});

	for (const envVar of ['HARPER_CONFIG', 'HARPER_SET_CONFIG']) {
		it(`filters overlapping write paths from ${envVar} without filtering sibling prefixes`, function () {
			for (const name of ENV_VARS) delete process.env[name];
			process.env[envVar] = JSON.stringify({
				http: { mtls: false, port: 8080 },
				threads: 4,
				operationsApi: { network: { port: 9925 } },
				tls: [],
			});

			assert.deepStrictEqual(
				filterArgsAgainstRuntimeConfig({
					HTTP_MTLS_REQUIRED: 'true',
					http_port: '9000',
					http_portal: 'keep',
					constructor: 'keep',
					_unrelated: 'keep',
					threads_count: '8',
					max_http_threads: '9',
					operationsapi_network: '{"port":9000}',
					operationsapi_network_secureport: '9926',
					tls_certificate: '/cert.pem',
					logging_level: 'debug',
				}),
				{
					http_portal: 'keep',
					constructor: 'keep',
					_unrelated: 'keep',
					operationsapi_network_secureport: '9926',
					logging_level: 'debug',
				}
			);
		});

		it(`keeps thread-count aliases beside a debug flag pinned by ${envVar}`, function () {
			for (const name of ENV_VARS) delete process.env[name];
			process.env[envVar] = JSON.stringify({ threads: { debug: true } });
			const args = { THREADS: '8', http_threads: '7', customfunctions_processes: '6', threads_count: '5' };
			assert.deepStrictEqual(filterArgsAgainstRuntimeConfig(args), {
				http_threads: '7',
				customfunctions_processes: '6',
				threads_count: '5',
			});
		});
	}

	describe('Does NOT filter HARPER_DEFAULT_CONFIG', function () {
		it('should NOT filter args that are only in HARPER_DEFAULT_CONFIG', function () {
			// This test verifies that we only filter against HARPER_CONFIG and HARPER_SET_CONFIG,
			// not HARPER_DEFAULT_CONFIG, because defaults should be overridable by individual env vars

			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: {
					port: 9999,
				},
			});
			// No HARPER_CONFIG or HARPER_SET_CONFIG

			const args = {
				http_port: '9926', // Should NOT be filtered (only in DEFAULT_CONFIG)
				rootpath: '/var/hdb',
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			assert.strictEqual(result.http_port, '9926', 'Individual env vars should override HARPER_DEFAULT_CONFIG');
			assert.strictEqual(result.rootpath, '/var/hdb');
		});
	});
});
