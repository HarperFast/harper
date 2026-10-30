'use strict';
const assert = require('node:assert');
const { PassThrough } = require('node:stream');
const { writeWithBackpressure } = require('#src/dataLayer/rocksdbBackup');

// A destroyed stream emits neither `drain` nor a second `error`, so a writer that waits only on those
// never settles. That is what a consumer abort looks like from inside the archive assembler.
describe('writeWithBackpressure', function () {
	it('rejects instead of hanging when the stream is already destroyed', async function () {
		const dest = new PassThrough();
		dest.on('error', () => {});
		dest.destroy(new Error('consumer went away'));
		await new Promise((resolve) => setImmediate(resolve));
		await assert.rejects(writeWithBackpressure(dest, Buffer.alloc(8)), /consumer went away/);
	});

	// destroy() with no error emits `close` and no `error` at all, so an error listener alone is not
	// enough even when it was attached before the teardown
	it('rejects instead of hanging when a backpressured write is closed without an error', async function () {
		const dest = new PassThrough({ highWaterMark: 1 });
		const pending = writeWithBackpressure(dest, Buffer.alloc(4096));
		setImmediate(() => dest.destroy());
		await assert.rejects(pending, /closed before the write drained/);
	});

	it('still resolves once an ordinary backpressured write drains', async function () {
		const dest = new PassThrough({ highWaterMark: 1 });
		const pending = writeWithBackpressure(dest, Buffer.alloc(4096));
		dest.resume();
		await pending;
	});
});
