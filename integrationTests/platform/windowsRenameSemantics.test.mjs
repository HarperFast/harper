/**
 * Probe: what actually blocks `fs.renameSync(tmp, dest)` on Windows.
 *
 * Temporary investigation harness for the `set_configuration` EPERM failure. Prints one
 * JSON line per case to the shard log; assertions are deliberately absent so a surprising
 * result is reported rather than hidden behind a red test.
 */
import { suite, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';

const RETRY_DELAYS = [10, 20, 40, 80, 160, 320, 500, 500, 500, 500, 500, 500];
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function attempt(from, to) {
	try {
		fs.renameSync(from, to);
		return { ok: true };
	} catch (error) {
		return { ok: false, code: error.code, message: error.message };
	}
}

function report(name, value) {
	console.log(`RENAME-PROBE ${name} ${JSON.stringify(value)}`);
}

suite('windows rename semantics probe', () => {
	test('records which handles block rename-over-destination', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-probe-'));
		report('env', { platform: process.platform, node: process.version, dir });

		const dest = path.join(dir, 'harper-config.yaml');
		let caseNumber = 0;
		const source = (n) => {
			const p = path.join(dir, `harper-config.yaml.${n}.${caseNumber++}.tmp`);
			fs.writeFileSync(p, `case: ${n}\n`.padEnd(4096, '#'));
			return p;
		};
		// Run the production backoff against a holder that is not expected to release, so a
		// blocked-loop case reports the same shape the server does.
		const retryLoop = (label) => {
			const attempts = [];
			for (let i = 0; i <= RETRY_DELAYS.length; i++) {
				attempts.push(attempt(source(label), dest));
				if (attempts.at(-1).ok) break;
				if (i < RETRY_DELAYS.length) Atomics.wait(sleepBuffer, 0, 0, RETRY_DELAYS[i]);
			}
			return {
				attempts: attempts.length,
				anyOk: attempts.some((a) => a.ok),
				first: attempts[0],
				last: attempts.at(-1),
			};
		};

		fs.writeFileSync(dest, 'case: base\n');
		report('A-control-no-handles', attempt(source('a'), dest));

		const syncFd = fs.openSync(dest, 'r');
		report('B-dest-held-by-open-sync-fd', attempt(source('b'), dest));
		fs.closeSync(syncFd);
		report('B2-after-closing-that-fd', attempt(source('b2'), dest));

		// The production shape: an in-flight fsPromises.readFile whose close() cannot run
		// because this thread is blocked in the retry loop.
		const inFlight = readFile(dest, 'utf-8');
		report('C-dest-held-by-in-flight-readFile-while-loop-blocks', retryLoop('c'));
		await inFlight;
		report('C2-after-awaiting-that-read', attempt(source('c-after'), dest));

		const awaited = await readFile(dest, 'utf-8');
		report('D-dest-read-awaited-first', { bytes: awaited.length, ...attempt(source('d'), dest) });

		const heldSource = source('e');
		const sourceFd = fs.openSync(heldSource, 'r');
		report('E-source-held-by-open-sync-fd', attempt(heldSource, dest));
		fs.closeSync(sourceFd);

		// A native file watcher is the one handle Harper holds on the config file
		// continuously, so it would make the failure permanent rather than intermittent.
		const fileWatcher = fs.watch(dest, () => {});
		report('G-dest-watched-by-fs-watch-file', attempt(source('g'), dest));
		fileWatcher.close();

		const dirWatcher = fs.watch(dir, () => {});
		report('H-dir-watched-by-fs-watch-dir', attempt(source('h'), dest));
		dirWatcher.close();

		const chokidarWatcher = chokidar.watch(dest, { persistent: false });
		await once(chokidarWatcher, 'ready');
		report('I-dest-watched-by-chokidar', attempt(source('i'), dest));
		const chokidarInFlight = readFile(dest, 'utf-8');
		report('J-chokidar-plus-in-flight-readFile', retryLoop('j'));
		await chokidarInFlight;
		await chokidarWatcher.close();

		// Delete-pending: on Windows a file unlinked while open keeps its name reserved
		// until the last handle closes, which would also reserve it against a rename.
		const pendingFd = fs.openSync(dest, 'r');
		let unlinked;
		try {
			fs.unlinkSync(dest);
			unlinked = { ok: true, stillExists: fs.existsSync(dest) };
		} catch (error) {
			unlinked = { ok: false, code: error.code };
		}
		report('F-unlink-while-open', unlinked);
		report('F2-rename-into-that-name', attempt(source('f'), dest));
		fs.closeSync(pendingFd);

		fs.rmSync(dir, { recursive: true, force: true });
	});
});
