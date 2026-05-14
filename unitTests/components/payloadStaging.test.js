'use strict';

const assert = require('node:assert');
const { Readable } = require('node:stream');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { stagePayloadToTempFile } = require('#src/components/payloadStaging');

describe('stagePayloadToTempFile', () => {
	it('writes a streamed payload to a temp file with the expected contents', async () => {
		const payload = Buffer.from('abcdefghij'.repeat(10000), 'utf8'); // 100 KB
		const { path: tmpPath, cleanup } = await stagePayloadToTempFile(Readable.from(payload), 'demo');
		try {
			const written = await readFile(tmpPath);
			assert.strictEqual(written.length, payload.length);
			assert.deepStrictEqual(written, payload);
			assert.match(tmpPath, /harper-deploy-demo-/, 'temp dir is named after the project');
			assert.strictEqual(path.basename(tmpPath), 'payload.tar.gz');
		} finally {
			await cleanup();
		}
	});

	it('cleanup() removes the staged file and its parent temp dir', async () => {
		const { path: tmpPath, cleanup } = await stagePayloadToTempFile(Readable.from('hello'), 'cleanup-test');
		await cleanup();
		await assert.rejects(stat(tmpPath), /ENOENT/, 'staged file must be gone');
		await assert.rejects(stat(path.dirname(tmpPath)), /ENOENT/, 'staged dir must be gone');
	});

	it('cleanup() is safe to call twice (force: true)', async () => {
		const { cleanup } = await stagePayloadToTempFile(Readable.from('hello'), 'double-cleanup');
		await cleanup();
		await cleanup(); // must not throw
	});

	it('sanitizes path-traversal characters in the project name', async () => {
		const { path: tmpPath, cleanup } = await stagePayloadToTempFile(Readable.from('x'), '../../evil/name');
		try {
			// Path separators must be replaced so the temp dir lives in a single mkdtemp slot
			// directly under tmpdir, not navigated upstream. `..` segments alone don't traverse
			// because there's no `/` between them after sanitization.
			const os = require('node:os');
			assert.strictEqual(
				path.dirname(path.dirname(tmpPath)),
				path.resolve(os.tmpdir()),
				'staged dir must live directly under tmpdir'
			);
			assert.doesNotMatch(path.basename(path.dirname(tmpPath)), /\//);
			assert.match(path.basename(path.dirname(tmpPath)), /harper-deploy-.+_evil_name-/);
		} finally {
			await cleanup();
		}
	});

	it('propagates source-stream errors through pipeline', async () => {
		const source = new Readable({
			read() {
				this.destroy(new Error('source boom'));
			},
		});
		await assert.rejects(stagePayloadToTempFile(source, 'erroring'), /source boom/);
	});
});
