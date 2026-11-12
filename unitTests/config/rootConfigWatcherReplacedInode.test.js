const assert = require('node:assert');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { stringify } = require('yaml');
const { RootConfigWatcher } = require('#src/config/RootConfigWatcher');
const { atomicWriteFile } = require('#src/config/configUtils');
const { waitFor } = require('../waitFor');

// On darwin chokidar watches the file through kqueue, whose registration lands only at the next event
// loop poll: a replace queued as a microtask from a `change` listener runs after chokidar re-watched the
// previous replacement and before that registration, so it reaches the window deterministically.
describe('RootConfigWatcher after the config file is replaced inside a re-watch', function () {
	this.timeout(30_000);
	let directory;
	let file;
	let watcher;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), 'harper.unit-test.root-config-replaced-inode-'));
		file = join(directory, 'harper-config.yaml');
		atomicWriteFile(file, stringify({ value: 'initial' }));
		watcher = new RootConfigWatcher(file);
		await watcher.ready;
	});

	afterEach(() => {
		watcher?.close();
		rmSync(directory, { recursive: true, force: true });
	});

	function raceReplaceOnFirstChange(content) {
		const seen = [];
		let raced = false;
		watcher.on('change', (config) => {
			seen.push(config.value);
			if (raced) return;
			raced = true;
			queueMicrotask(() => atomicWriteFile(file, stringify({ value: content })));
		});
		return seen;
	}

	async function assertLaterWriteDelivered(seen) {
		// Past the trailing verify-read and a re-opened watch's arming.
		await delay(500);
		writeFileSync(file, stringify({ value: 'in-place' }));
		await waitFor(() => seen.at(-1) === 'in-place', {
			timeout: 5000,
			message: () => `a write after the raced replace was never delivered; saw ${JSON.stringify(seen)}`,
		});
	}

	it('keeps delivering writes after a replace lands inside the re-watch of the previous one', async () => {
		const seen = raceReplaceOnFirstChange('second');
		atomicWriteFile(file, stringify({ value: 'first' }));
		await waitFor(() => seen.includes('second'), 5000);
		await assertLaterWriteDelivered(seen);
	});

	it('re-opens the watch even when the raced replace carries identical content', async () => {
		const seen = raceReplaceOnFirstChange('first');
		atomicWriteFile(file, stringify({ value: 'first' }));
		await waitFor(() => seen.includes('first'), 5000);
		await assertLaterWriteDelivered(seen);
	});

	it('does not re-open the watch for a single replace', async () => {
		const seen = [];
		watcher.on('change', (config) => seen.push(config.value));
		atomicWriteFile(file, stringify({ value: 'first' }));
		await waitFor(() => seen.includes('first'), 5000);
		await delay(300);
		assert.strictEqual(watcher._openCountForTests, 1);
		writeFileSync(file, stringify({ value: 'in-place' }));
		await waitFor(() => seen.at(-1) === 'in-place', 5000);
	});

	it('does not re-open a watch that was closed while its verify-read was pending', async () => {
		const seen = raceReplaceOnFirstChange('second');
		atomicWriteFile(file, stringify({ value: 'first' }));
		await waitFor(() => seen.includes('first'), 5000);
		watcher.close();
		await delay(300);
		assert.strictEqual(watcher._openCountForTests, 1);
	});
});
