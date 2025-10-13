'use strict';

const assert = require('node:assert/strict');
const rewire = require('rewire');
const harperConfigEnvVars = rewire('../../config/harperConfigEnvVars.ts');

// Access internal functions for testing
const parseConfigEnvVar = harperConfigEnvVars.__get__('parseConfigEnvVar');
const ConfigEnvVarError = harperConfigEnvVars.__get__('ConfigEnvVarError');
const hashConfig = harperConfigEnvVars.__get__('hashConfig');

describe('harperConfigEnvVars', function () {

	describe('hashConfig', function () {
		it('produces different hashes for different configs', function () {
			const config1 = { http: { foo: true, mtls: true } };
			const config2 = { http: { foo: true, boo: 'bat' } };

			const hash1 = hashConfig(config1);
			const hash2 = hashConfig(config2);

			assert.notEqual(hash1, hash2, 'Different configs should have different hashes');
		});

		it('produces same hash for same config with different key order', function () {
			const config1 = { http: { port: 9999, cors: true } };
			const config2 = { http: { cors: true, port: 9999 } };

			const hash1 = hashConfig(config1);
			const hash2 = hashConfig(config2);

			assert.equal(hash1, hash2, 'Same config with different key order should have same hash');
		});

		it('produces different hashes for nested config differences', function () {
			const config1 = { http: { cors: { enabled: true } } };
			const config2 = { http: { cors: { enabled: false } } };

			const hash1 = hashConfig(config1);
			const hash2 = hashConfig(config2);

			assert.notEqual(hash1, hash2, 'Nested differences should produce different hashes');
		});

		it('handles arrays correctly in hash', function () {
			const config1 = { http: { origins: ['*.example.com'] } };
			const config2 = { http: { origins: ['*.test.com'] } };

			const hash1 = hashConfig(config1);
			const hash2 = hashConfig(config2);

			assert.notEqual(hash1, hash2, 'Different arrays should produce different hashes');
		});

		it('produces same hash for deeply nested configs with different key order', function () {
			const config1 = {
				http: { port: 9999, cors: true },
				logging: { level: 'debug', file: true },
			};
			const config2 = {
				logging: { file: true, level: 'debug' },
				http: { cors: true, port: 9999 },
			};

			const hash1 = hashConfig(config1);
			const hash2 = hashConfig(config2);

			assert.equal(hash1, hash2, 'Deep configs with different key order should have same hash');
		});
	});

	describe('parseConfigEnvVar', function () {
		it('parses valid JSON', function () {
			const result = parseConfigEnvVar('{"http":{"port":9999}}', 'TEST_VAR');
			assert.deepEqual(result, { http: { port: 9999 } });
		});

		it('returns null for empty string', function () {
			const result = parseConfigEnvVar('', 'TEST_VAR');
			assert.equal(result, null);
		});

		it('returns null for undefined', function () {
			const result = parseConfigEnvVar(undefined, 'TEST_VAR');
			assert.equal(result, null);
		});

		it('returns null for null', function () {
			const result = parseConfigEnvVar(null, 'TEST_VAR');
			assert.equal(result, null);
		});

		it('trims whitespace', function () {
			const result = parseConfigEnvVar('  {"http":{"port":9999}}  ', 'TEST_VAR');
			assert.deepEqual(result, { http: { port: 9999 } });
		});

		it('throws ConfigEnvVarError for invalid JSON', function () {
			assert.throws(() => parseConfigEnvVar('{invalid json}', 'TEST_VAR'), ConfigEnvVarError);
		});

		it('throws ConfigEnvVarError for non-object JSON (array)', function () {
			assert.throws(
				() => parseConfigEnvVar('["array", "not", "object"]', 'TEST_VAR'),
				(error) => {
					return error instanceof ConfigEnvVarError && error.message.includes('must be a JSON object');
				}
			);
		});

		it('throws ConfigEnvVarError for non-object JSON (string)', function () {
			assert.throws(
				() => parseConfigEnvVar('"just a string"', 'TEST_VAR'),
				(error) => {
					return error instanceof ConfigEnvVarError && error.message.includes('must be a JSON object');
				}
			);
		});

		it('throws ConfigEnvVarError for non-object JSON (number)', function () {
			assert.throws(
				() => parseConfigEnvVar('12345', 'TEST_VAR'),
				(error) => {
					return error instanceof ConfigEnvVarError && error.message.includes('must be a JSON object');
				}
			);
		});

		it('includes env var name in error', function () {
			try {
				parseConfigEnvVar('{bad}', 'MY_CONFIG');
				assert.fail('Should have thrown');
			} catch (error) {
				assert.equal(error.envVarName, 'MY_CONFIG');
				assert.match(error.message, /MY_CONFIG/);
			}
		});

		it('includes original error in ConfigEnvVarError', function () {
			try {
				parseConfigEnvVar('{bad}', 'MY_CONFIG');
				assert.fail('Should have thrown');
			} catch (error) {
				assert.ok(error.originalError);
				assert.ok(error.originalError instanceof SyntaxError);
			}
		});

		it('parses complex nested JSON', function () {
			const json = JSON.stringify({
				http: {
					port: 9999,
					cors: true,
					corsAccessList: ['*.example.com', '*.test.com'],
				},
				logging: {
					level: 'debug',
				},
				replication: {
					routes: [{ hostname: 'node1.com' }, { hostname: 'node2.com' }],
				},
			});
			const result = parseConfigEnvVar(json, 'TEST_VAR');
			assert.deepEqual(result, {
				http: {
					port: 9999,
					cors: true,
					corsAccessList: ['*.example.com', '*.test.com'],
				},
				logging: {
					level: 'debug',
				},
				replication: {
					routes: [{ hostname: 'node1.com' }, { hostname: 'node2.com' }],
				},
			});
		});
	});

	describe('ConfigEnvVarError', function () {
		it('has correct properties', function () {
			const originalError = new Error('Original');
			const error = new ConfigEnvVarError('Test message', 'TEST_VAR', originalError);

			assert.equal(error.name, 'ConfigEnvVarError');
			assert.equal(error.message, 'Test message');
			assert.equal(error.envVarName, 'TEST_VAR');
			assert.equal(error.originalError, originalError);
		});

		it('works without originalError', function () {
			const error = new ConfigEnvVarError('Test message', 'TEST_VAR');

			assert.equal(error.name, 'ConfigEnvVarError');
			assert.equal(error.message, 'Test message');
			assert.equal(error.envVarName, 'TEST_VAR');
			assert.equal(error.originalError, undefined);
		});

		it('is instanceof Error', function () {
			const error = new ConfigEnvVarError('Test', 'VAR');
			assert.ok(error instanceof Error);
		});
	});
});
