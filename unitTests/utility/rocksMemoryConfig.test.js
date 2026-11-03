'use strict';

const assert = require('node:assert');
const { resolveRocksMemoryConfig, resolveRocksArenaBlockSize } = require('#src/utility/rocksMemoryConfig');

const GB = 1024 * 1024 * 1024;

function resolve(overrides) {
	return resolveRocksMemoryConfig({
		configuredBlockCacheSize: undefined,
		configuredWriteBufferManagerSize: undefined,
		configuredCostToCache: undefined,
		configuredAllowStall: undefined,
		configuredFlushPolicy: undefined,
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
			assert.strictEqual(config.writeBufferManagerSize, Math.floor((2 * GB) / 3));
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
			assert.ok(
				!(
					'writeBufferManagerFlushPolicy' in
					resolve({ configuredWriteBufferManagerSize: 0, configuredFlushPolicy: 'largest' })
				)
			);
		});

		it('falls back to the default for non-number values', function () {
			assert.strictEqual(
				resolve({ configuredWriteBufferManagerSize: 'lots' }).writeBufferManagerSize,
				Math.floor((2 * GB) / 3)
			);
		});
	});

	describe('integer flooring', function () {
		it('floors a fractional block cache default', function () {
			// 10 * 0.25 = 2.5 -> 2
			assert.strictEqual(resolve({ availableMemory: 10 }).blockCacheSize, 2);
		});

		it('floors a fractional WriteBufferManager default', function () {
			// floor(10 / 3) = 3
			const config = resolve({ configuredBlockCacheSize: 10 });
			assert.strictEqual(config.writeBufferManagerSize, 3);
		});

		it('produces integer sizes for a realistic constrained memory limit', function () {
			// 6 GB cgroup limit: block cache 1.5 GB, WBM 1.5 GB / 3
			const config = resolve({ availableMemory: 6 * GB });
			assert.ok(Number.isInteger(config.blockCacheSize));
			assert.ok(Number.isInteger(config.writeBufferManagerSize));
		});
	});

	describe('costToCache and allowStall', function () {
		it('default costToCache to true and allowStall to false when the WBM is enabled', function () {
			const config = resolve({});
			assert.strictEqual(config.writeBufferManagerCostToCache, true);
			assert.strictEqual(config.writeBufferManagerAllowStall, false);
		});

		it('honor explicit false values', function () {
			const config = resolve({ configuredCostToCache: false, configuredAllowStall: false });
			assert.strictEqual(config.writeBufferManagerCostToCache, false);
			assert.strictEqual(config.writeBufferManagerAllowStall, false);
		});

		it('honor explicit true values', function () {
			const config = resolve({ configuredCostToCache: true, configuredAllowStall: true });
			assert.strictEqual(config.writeBufferManagerCostToCache, true);
			assert.strictEqual(config.writeBufferManagerAllowStall, true);
		});

		it('fall back to their defaults for non-boolean values', function () {
			const config = resolve({ configuredCostToCache: 'yes', configuredAllowStall: 1 });
			assert.strictEqual(config.writeBufferManagerCostToCache, true);
			assert.strictEqual(config.writeBufferManagerAllowStall, false);
			assert.strictEqual(resolve({ configuredAllowStall: 'true' }).writeBufferManagerAllowStall, false);
		});
	});

	describe('flush policy', function () {
		it('is left unset when not configured, so rocksdb-js picks it', function () {
			assert.ok(!('writeBufferManagerFlushPolicy' in resolve({})));
			assert.ok(!('writeBufferManagerFlushPolicy' in resolve({ configuredFlushPolicy: null })));
			assert.ok(!('writeBufferManagerFlushPolicy' in resolve({ configuredAllowStall: true })));
		});

		it('passes each supported policy through', function () {
			for (const policy of ['oldest', 'largest', 'largestAcrossDBs']) {
				assert.strictEqual(resolve({ configuredFlushPolicy: policy }).writeBufferManagerFlushPolicy, policy);
			}
		});

		it('is left unset for an unknown policy name or a non-string value', function () {
			for (const configuredFlushPolicy of [
				'largestacrossdbs',
				'newest',
				'',
				1,
				true,
				['oldest'],
				{ policy: 'oldest' },
			]) {
				assert.ok(
					!('writeBufferManagerFlushPolicy' in resolve({ configuredFlushPolicy })),
					String(configuredFlushPolicy)
				);
			}
		});
	});
});

describe('resolveRocksArenaBlockSize', function () {
	it('is undefined when not configured, so rocksdb-js sizes the arena', function () {
		assert.strictEqual(resolveRocksArenaBlockSize(undefined), undefined);
		assert.strictEqual(resolveRocksArenaBlockSize(null), undefined);
	});

	it('passes a positive integer through', function () {
		assert.strictEqual(resolveRocksArenaBlockSize(65536), 65536);
		assert.strictEqual(resolveRocksArenaBlockSize(1), 1);
	});

	it('treats 0 as automatic', function () {
		assert.strictEqual(resolveRocksArenaBlockSize(0), undefined);
	});

	it('is undefined for values the native layer would reject', function () {
		for (const value of [-65536, 65536.5, NaN, Infinity, -Infinity, 2 ** 53]) {
			assert.strictEqual(resolveRocksArenaBlockSize(value), undefined, String(value));
		}
	});

	it('is undefined for non-number values', function () {
		for (const value of ['65536', true, {}, [65536]]) {
			assert.strictEqual(resolveRocksArenaBlockSize(value), undefined, String(value));
		}
	});
});
