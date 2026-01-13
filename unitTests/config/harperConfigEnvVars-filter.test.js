'use strict';

const assert = require('node:assert/strict');
const { filterArgsAgainstRuntimeConfig } = require('#src/config/harperConfigEnvVars');

describe('filterArgsAgainstRuntimeConfig', function () {
	let originalEnv;

	beforeEach(function () {
		// Save original env var
		originalEnv = process.env.HARPER_SET_CONFIG;
	});

	afterEach(function () {
		// Restore original env var
		if (originalEnv !== undefined) {
			process.env.HARPER_SET_CONFIG = originalEnv;
		} else {
			delete process.env.HARPER_SET_CONFIG;
		}
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

	describe('Does NOT filter HARPER_DEFAULT_CONFIG', function () {
		it('should NOT filter args that are only in HARPER_DEFAULT_CONFIG', function () {
			// This test verifies that we only filter against HARPER_SET_CONFIG,
			// not HARPER_DEFAULT_CONFIG, because defaults should be overridable by individual env vars

			process.env.HARPER_DEFAULT_CONFIG = JSON.stringify({
				http: {
					port: 9999,
				},
			});
			// No HARPER_SET_CONFIG

			const args = {
				http_port: '9926', // Should NOT be filtered (only in DEFAULT_CONFIG, not SET_CONFIG)
				rootpath: '/var/hdb',
			};

			const result = filterArgsAgainstRuntimeConfig(args);

			assert.strictEqual(result.http_port, '9926', 'Individual env vars should override HARPER_DEFAULT_CONFIG');
			assert.strictEqual(result.rootpath, '/var/hdb');
		});
	});
});
