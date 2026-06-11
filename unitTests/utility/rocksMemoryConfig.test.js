'use strict';

const assert = require('assert');
const { resolveRocksMemoryConfig } = require('#src/utility/rocksMemoryConfig');

const GB = 1024 * 1024 * 1024;

function resolve(overrides) {
	return resolveRocksMemoryConfig({
		configuredBlockCacheSize: undefined,
		configuredWriteBufferManagerSize: undefined,
		configuredCostToCache: undefined,
		configuredAllowStall: undefined,
		availableMemory: 8 * GB,
		...overrides,
	});
}

describe('resolveRocksMemoryConfig', function () {
	describe('block cache', function () {
		it('defaults to 25% of available memory when unset', function () {
			assert.strictEqual(resolve({}).blockCacheSize, 2 * GB);
		});

		it('honors an explicit positive size', function () {
			assert.strictEqual(resolve({ configuredBlockCacheSize: 512 * 1024 * 1024 }).blockCacheSize, 512 * 1024 * 1024);
		});

		it('falls back to the default for zero, negative, or non-number values', function () {
			assert.strictEqual(resolve({ configuredBlockCacheSize: 0 }).blockCacheSize, 2 * GB);
			assert.strictEqual(resolve({ configuredBlockCacheSize: -1 }).blockCacheSize, 2 * GB);
			assert.strictEqual(resolve({ configuredBlockCacheSize: 'big' }).blockCacheSize, 2 * GB);
		});
	});

	describe('WriteBufferManager size', function () {
		it('defaults to 1/3 of the resolved block cache when unset', function () {
			const config = resolve({});
			assert.strictEqual(config.writeBufferManagerSize, (2 * GB) / 3);
		});

		it('defaults relative to an explicit block cache size', function () {
			const config = resolve({ configuredBlockCacheSize: 900 });
			assert.strictEqual(config.writeBufferManagerSize, 300);
		});

		it('honors an explicit positive size', function () {
			assert.strictEqual(
				resolve({ configuredWriteBufferManagerSize: 256 * 1024 * 1024 }).writeBufferManagerSize,
				256 * 1024 * 1024
			);
		});

		it('disables the WBM entirely when explicitly set to 0', function () {
			const config = resolve({ configuredWriteBufferManagerSize: 0 });
			assert.ok(!('writeBufferManagerSize' in config));
			assert.ok(!('writeBufferManagerCostToCache' in config));
			assert.ok(!('writeBufferManagerAllowStall' in config));
		});

		it('falls back to the default for non-number values', function () {
			assert.strictEqual(resolve({ configuredWriteBufferManagerSize: 'lots' }).writeBufferManagerSize, (2 * GB) / 3);
		});
	});

	describe('costToCache and allowStall', function () {
		it('both default to true when the WBM is enabled', function () {
			const config = resolve({});
			assert.strictEqual(config.writeBufferManagerCostToCache, true);
			assert.strictEqual(config.writeBufferManagerAllowStall, true);
		});

		it('honor explicit false values', function () {
			const config = resolve({ configuredCostToCache: false, configuredAllowStall: false });
			assert.strictEqual(config.writeBufferManagerCostToCache, false);
			assert.strictEqual(config.writeBufferManagerAllowStall, false);
		});

		it('fall back to true for non-boolean values', function () {
			const config = resolve({ configuredCostToCache: 'yes', configuredAllowStall: 1 });
			assert.strictEqual(config.writeBufferManagerCostToCache, true);
			assert.strictEqual(config.writeBufferManagerAllowStall, true);
		});
	});
});
