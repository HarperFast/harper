'use strict';

const assert = require('node:assert');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Worker } = require('node:worker_threads');

const FIXTURE = join(__dirname, 'laterLoadsMeetFrozenIntrinsics-fixture.cjs');

/** Reads the predicate in a worker before and after it starts a boot load, under the given lockdown. */
async function probe(lockdown) {
	const storagePath = mkdtempSync(join(tmpdir(), 'harper-later-loads-'));
	const config = readFileSync(join(__dirname, '../../../static/defaultConfig.yaml'), 'utf8')
		.replace(/^ {2}file: true$/m, '  file: false')
		.replace(/^ {2}root: null$/m, `  root: ${JSON.stringify(storagePath)}`)
		.replace(/^rootPath: null$/m, `rootPath: ${JSON.stringify(storagePath)}`)
		.replace(/^ {2}path: null$/m, `  path: ${JSON.stringify(storagePath)}`)
		.replace(/^ {2}lockdown: freeze-after-load$/m, `  lockdown: ${lockdown}`);
	writeFileSync(join(storagePath, 'harper-config.yaml'), config);
	const worker = new Worker(FIXTURE, {
		workerData: { addPorts: [], addThreadIds: [], noServerStart: true, storagePath },
	});
	try {
		return await new Promise((resolve, reject) => {
			worker.on('message', (message) => {
				if (message.type === 'probe') resolve(message);
			});
			worker.on('error', reject);
			worker.on('exit', (code) => reject(new Error(`worker exited with code ${code} before reporting`)));
		});
	} finally {
		await worker.terminate();
		rmSync(storagePath, { recursive: true, force: true });
	}
}

describe('laterLoadsMeetFrozenIntrinsics', () => {
	it('holds under freeze-after-load once the thread has started its boot load', async () => {
		const { beforeBootLoad, afterBootLoad } = await probe('freeze-after-load');
		assert.equal(beforeBootLoad, false, 'a thread that runs no boot load never freezes after one');
		assert.equal(afterBootLoad, true);
	});

	for (const lockdown of ['none', 'freeze', 'ses']) {
		it(`does not hold under lockdown: ${lockdown}, where later loads meet what the boot load met`, async () => {
			const { beforeBootLoad, afterBootLoad } = await probe(lockdown);
			assert.equal(beforeBootLoad, false);
			assert.equal(afterBootLoad, false);
		});
	}
});
