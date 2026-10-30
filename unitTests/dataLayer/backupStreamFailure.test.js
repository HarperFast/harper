'use strict';

const assert = require('node:assert/strict');
const { finished } = require('node:stream/promises');
const { setImmediate } = require('node:timers/promises');
const { createBackupStream } = require('#src/dataLayer/rocksdbBackup');

describe('backup stream producer failure', function () {
	it('propagates rejection while an engine-only consumer is backpressured', async function () {
		this.timeout(5000);
		const failure = new Error('native backup failed under backpressure');
		const producer = {
			async backup(destination) {
				const writer = destination.getWriter();
				writer.closed.catch(() => {});
				await writer.write(Buffer.alloc(256 * 1024));
				await writer.write(Buffer.alloc(256 * 1024));
				await setImmediate();
				await writer.abort(failure);
				throw failure;
			},
		};
		const stream = createBackupStream(producer, 'backup-stream-failure', false, true);
		try {
			await assert.rejects(finished(stream, { signal: AbortSignal.timeout(2000) }), (error) => error === failure);
		} finally {
			stream.destroy();
		}
	});

	for (const gzip of [false, true]) {
		for (const excludeBlobs of [false, true]) {
			for (const partial of [false, true]) {
				it(`propagates ${partial ? 'mid-stream' : 'immediate'} rejection (gzip=${gzip}, excludeBlobs=${excludeBlobs})`, async function () {
					this.timeout(5000);
					const failure = new Error('native backup failed');
					let writerClosed;
					const producer = {
						async backup(destination) {
							const writer = destination.getWriter();
							writerClosed = writer.closed.catch((error) => error);
							if (partial) {
								await writer.write(Buffer.alloc(2048));
								await setImmediate();
							}
							// Native failure may reject without closing or aborting its writable.
							throw failure;
						},
					};
					const stream = createBackupStream(producer, 'backup-stream-failure', gzip, excludeBlobs);
					const completion = finished(stream, { signal: AbortSignal.timeout(2000) });
					stream.resume();
					try {
						await assert.rejects(completion, (error) => error === failure);
						assert.strictEqual(await writerClosed, failure);
					} finally {
						stream.destroy();
					}
				});
			}
		}
	}
});
