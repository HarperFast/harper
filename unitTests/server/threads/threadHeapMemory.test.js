'use strict';

const assert = require('node:assert');

const { resolveThreadHeapMemoryMb, isStartableThreadHeapMemory } = require('#src/server/threads/threadHeapMemory');
const { MIN_THREAD_HEAP_MEMORY_MB } = require('#src/utility/hdbTerms');

describe('resolveThreadHeapMemoryMb', () => {
	it('returns undefined when unconfigured, so the caller computes its default', () => {
		assert.strictEqual(resolveThreadHeapMemoryMb(undefined), undefined);
		assert.strictEqual(resolveThreadHeapMemoryMb(null), undefined);
	});

	it('honors a configured value at or above the minimum', () => {
		assert.strictEqual(resolveThreadHeapMemoryMb(MIN_THREAD_HEAP_MEMORY_MB), MIN_THREAD_HEAP_MEMORY_MB);
		assert.strictEqual(resolveThreadHeapMemoryMb(300), 300);
		assert.strictEqual(resolveThreadHeapMemoryMb('300'), 300);
	});

	it('recovers to the computed default for a value below the minimum', () => {
		assert.strictEqual(resolveThreadHeapMemoryMb(1), undefined);
		assert.strictEqual(resolveThreadHeapMemoryMb(0), undefined);
		assert.strictEqual(resolveThreadHeapMemoryMb(-1), undefined);
		assert.strictEqual(resolveThreadHeapMemoryMb(MIN_THREAD_HEAP_MEMORY_MB - 1), undefined);
		assert.strictEqual(resolveThreadHeapMemoryMb('1'), undefined);
	});

	it('recovers to the computed default for a non-numeric value', () => {
		assert.strictEqual(resolveThreadHeapMemoryMb('lots'), undefined);
		assert.strictEqual(resolveThreadHeapMemoryMb({}), undefined);
		assert.strictEqual(resolveThreadHeapMemoryMb(NaN), undefined);
		assert.strictEqual(resolveThreadHeapMemoryMb(Infinity), undefined);
	});
});

describe('isStartableThreadHeapMemory', () => {
	it('accepts only finite numbers at or above the minimum', () => {
		assert.strictEqual(isStartableThreadHeapMemory(MIN_THREAD_HEAP_MEMORY_MB), true);
		assert.strictEqual(isStartableThreadHeapMemory(MIN_THREAD_HEAP_MEMORY_MB - 1), false);
		assert.strictEqual(isStartableThreadHeapMemory(0), false);
		assert.strictEqual(isStartableThreadHeapMemory(-1), false);
		assert.strictEqual(isStartableThreadHeapMemory(Infinity), false);
		assert.strictEqual(isStartableThreadHeapMemory(NaN), false);
		assert.strictEqual(isStartableThreadHeapMemory('300'), false);
	});
});
