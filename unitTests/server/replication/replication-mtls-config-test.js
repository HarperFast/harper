const assert = require('node:assert/strict');

describe('server/replication/replicator.ts - buildReplicationMtlsConfig', function () {
	let replicator;

	before(function () {
		replicator = require('../../../server/replication/replicator.ts');
	});

	describe('buildReplicationMtlsConfig', function () {
		it('should return true when no mtls config is provided', function () {
			const result = replicator.buildReplicationMtlsConfig({});
			assert.strictEqual(result, true);
		});

		it('should return true when options is null', function () {
			const result = replicator.buildReplicationMtlsConfig(null);
			assert.strictEqual(result, true);
		});

		it('should return true when options is undefined', function () {
			const result = replicator.buildReplicationMtlsConfig(undefined);
			assert.strictEqual(result, true);
		});

		it('should return mtls config object when certificateVerification is true', function () {
			const options = {
				mtls: {
					certificateVerification: true,
				},
			};
			const result = replicator.buildReplicationMtlsConfig(options);
			assert.deepStrictEqual(result, { certificateVerification: true });
		});

		it('should return full mtls config with nested certificateVerification settings', function () {
			const options = {
				mtls: {
					certificateVerification: {
						failureMode: 'fail-closed',
						crl: {
							enabled: true,
							timeout: 5000,
							cacheTtl: 3600000,
						},
						ocsp: {
							enabled: false,
						},
					},
				},
			};
			const result = replicator.buildReplicationMtlsConfig(options);
			assert.deepStrictEqual(result, options.mtls);
		});

		it('should preserve mtls config when it is a boolean true', function () {
			const options = {
				mtls: true,
			};
			const result = replicator.buildReplicationMtlsConfig(options);
			assert.strictEqual(result, true);
		});

		it('should handle mtls config with only some certificate verification settings', function () {
			const options = {
				mtls: {
					certificateVerification: {
						crl: {
							enabled: true,
						},
					},
				},
			};
			const result = replicator.buildReplicationMtlsConfig(options);
			assert.deepStrictEqual(result, options.mtls);
		});

		// mTLS is always required for replication (security requirement)
		// Even if config tries to disable it, we force it to be enabled
		it('should override mtls: false and return true (mTLS required for replication)', function () {
			const options = {
				mtls: false,
			};
			const result = replicator.buildReplicationMtlsConfig(options);
			// mTLS cannot be disabled for replication - always returns true
			assert.strictEqual(result, true);
		});

		it('should override mtls: null and return true (mTLS required for replication)', function () {
			const options = {
				mtls: null,
			};
			const result = replicator.buildReplicationMtlsConfig(options);
			// mTLS cannot be disabled for replication - always returns true
			assert.strictEqual(result, true);
		});
	});
});
