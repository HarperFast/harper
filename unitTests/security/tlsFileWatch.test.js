'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const chokidar = require('chokidar');
const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { loadAndWatch } = require('#src/security/keys');
const { waitFor } = require('../waitFor.js');

// chokidar's removal throttle; a cancelled renewal only loses track of the file inside it (security/DESIGN.md).
const CHOKIDAR_REMOVE_THROTTLE_MS = 100;

describe('TLS file watch after a cancelled renewal', () => {
	const realWatch = chokidar.default.watch;
	const previousInterval = env.get(CONFIG_PARAMS.TLS_CERTIFICATEWATCHINTERVAL);
	let watchDir;
	let certPath;
	let keyPath;
	let watchers = [];
	let loaded;

	before(() => {
		env.setProperty(CONFIG_PARAMS.TLS_CERTIFICATEWATCHINTERVAL, 0);
	});

	after(() => {
		env.setProperty(CONFIG_PARAMS.TLS_CERTIFICATEWATCHINTERVAL, previousInterval);
	});

	beforeEach(() => {
		watchers = [];
		chokidar.default.watch = (...args) => {
			const watcher = realWatch.apply(chokidar.default, args);
			watchers.push(watcher);
			return watcher;
		};
		watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-file-watch-'));
		certPath = path.join(watchDir, 'certificate.pem');
		keyPath = path.join(watchDir, 'keys', 'privateKey.pem');
		fs.mkdirSync(path.dirname(keyPath));
		fs.writeFileSync(certPath, 'CERT-1');
		fs.writeFileSync(keyPath, 'KEY-1');
		loaded = [];
	});

	afterEach(async () => {
		chokidar.default.watch = realWatch;
		await Promise.all(watchers.map((watcher) => watcher.close()));
		if (watchDir) fs.rmSync(watchDir, { recursive: true, force: true });
	});

	async function watchPair() {
		loadAndWatch(
			certPath,
			(certificate) => {
				const pair = `${certificate}+${fs.readFileSync(keyPath, 'utf8')}`;
				loaded.push(pair);
				return /^CERT-\d\+KEY-\d$/.test(pair);
			},
			'certificate',
			[keyPath]
		);
		let readyCount = 0;
		for (const watcher of watchers) watcher.once('ready', () => readyCount++);
		await waitFor(() => readyCount === watchers.length, {
			timeout: 5000,
			message: 'the TLS watchers never became ready',
		});
	}

	async function waitForLoaded(pair, loadCount) {
		try {
			await waitFor(() => loaded.at(-1) === pair && loaded.length >= loadCount, { timeout: 5000, interval: 1 });
		} catch {
			assert.fail(`${pair} was never loaded: ${loaded}`);
		}
	}

	/** Returns how long after the first removal the second one happened. */
	async function cancelRenewal(filePath, unmatchedPair) {
		const savedPath = filePath + '.saved';
		const start = performance.now();
		await fsp.rename(filePath, savedPath);
		await fsp.writeFile(filePath, 'UNMATCHED');
		await waitForLoaded(unmatchedPair, 2);
		await fsp.unlink(filePath);
		const elapsed = performance.now() - start;
		await fsp.rename(savedPath, filePath);
		return elapsed;
	}

	// A run that missed the window passes with or without the fix, so it must not count as coverage.
	function requireThrottleWindow(test, elapsed) {
		if (elapsed >= CHOKIDAR_REMOVE_THROTTLE_MS) test.skip();
	}

	function churnUnrelatedFile() {
		let churning = true;
		const churn = (async () => {
			while (churning) {
				await fsp.appendFile(path.join(watchDir, 'unrelated.log'), 'x');
				await delay(20);
			}
		})();
		churn.catch(() => {});
		return async () => {
			churning = false;
			await churn;
		};
	}

	it('re-reads a certificate restored right after an unmatched one', async function () {
		await watchPair();
		const elapsed = await cancelRenewal(certPath, 'UNMATCHED+KEY-1');
		await waitForLoaded('CERT-1+KEY-1', 3);
		requireThrottleWindow(this, elapsed);
	});

	it('re-reads a private key restored right after an unmatched one', async function () {
		await watchPair();
		const elapsed = await cancelRenewal(keyPath, 'CERT-1+UNMATCHED');
		await waitForLoaded('CERT-1+KEY-1', 3);
		requireThrottleWindow(this, elapsed);
	});

	it('reads a renewal installed after the cancelled one has settled', async function () {
		await watchPair();
		const elapsed = await cancelRenewal(certPath, 'UNMATCHED+KEY-1');
		// Outlasts any re-check of the restore, so only an event from this renewal can reveal it.
		await delay(1500);
		await fsp.writeFile(certPath + '.next', 'CERT-2');
		await fsp.rename(certPath + '.next', certPath);
		await waitForLoaded('CERT-2+KEY-1', 3);
		requireThrottleWindow(this, elapsed);
	});

	it('re-reads the restore while unrelated files in its directory keep changing', async function () {
		await watchPair();
		const stopChurn = churnUnrelatedFile();
		let elapsed;
		try {
			elapsed = await cancelRenewal(certPath, 'UNMATCHED+KEY-1');
			await waitForLoaded('CERT-1+KEY-1', 3);
		} finally {
			await stopChurn();
		}
		requireThrottleWindow(this, elapsed);
	});

	it('does not re-attempt an unchanged unmatched pair while unrelated files keep changing', async () => {
		await watchPair();
		await fsp.writeFile(certPath + '.next', 'UNMATCHED');
		await fsp.rename(certPath + '.next', certPath);
		await waitForLoaded('UNMATCHED+KEY-1', 2);
		// Outlasts the re-check this installation armed.
		await delay(1500);
		const attempts = loaded.length;
		const stopChurn = churnUnrelatedFile();
		try {
			await delay(2500);
		} finally {
			await stopChurn();
		}
		assert.strictEqual(loaded.length, attempts, `unchanged pair re-attempted: ${loaded}`);
	});
});
