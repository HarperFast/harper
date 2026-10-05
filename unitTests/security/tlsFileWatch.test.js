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

describe('TLS file watch after a cancelled renewal', () => {
	const realWatch = chokidar.default.watch;
	const previousInterval = env.get(CONFIG_PARAMS.TLS_CERTIFICATEWATCHINTERVAL);
	let watchDir;
	let certPath;
	let keyPath;
	let watchers = [];
	let loaded;
	let reportedPaths;

	before(() => {
		env.setProperty(CONFIG_PARAMS.TLS_CERTIFICATEWATCHINTERVAL, 0);
	});

	after(() => {
		env.setProperty(CONFIG_PARAMS.TLS_CERTIFICATEWATCHINTERVAL, previousInterval);
	});

	beforeEach(() => {
		watchers = [];
		reportedPaths = new Set();
		chokidar.default.watch = (...args) => {
			const watcher = realWatch.apply(chokidar.default, args);
			const report = (reportedPath) => reportedPaths.add(path.resolve(reportedPath));
			watcher.on('add', report).on('change', report);
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
				const pair = `${certificate}+${fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8') : 'MISSING'}`;
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

	async function cancelRenewal(filePath, unmatchedPair) {
		const savedPath = filePath + '.saved';
		await fsp.rename(filePath, savedPath);
		await fsp.writeFile(filePath, 'UNMATCHED');
		await waitForLoaded(unmatchedPair, 2);
		await fsp.unlink(filePath);
		reportedPaths.clear();
		await fsp.rename(savedPath, filePath);
	}

	// chokidar still reporting the path means it did not lose track of it, so only its own events were exercised.
	function requireLostTracking(test, filePath) {
		if (reportedPaths.has(path.resolve(filePath))) test.skip();
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
		await cancelRenewal(certPath, 'UNMATCHED+KEY-1');
		await waitForLoaded('CERT-1+KEY-1', 3);
		requireLostTracking(this, certPath);
	});

	it('re-reads a private key restored right after an unmatched one', async function () {
		await watchPair();
		await cancelRenewal(keyPath, 'CERT-1+UNMATCHED');
		await waitForLoaded('CERT-1+KEY-1', 3);
		requireLostTracking(this, keyPath);
	});

	it('reads a renewal installed after the cancelled one has settled', async function () {
		await watchPair();
		await cancelRenewal(certPath, 'UNMATCHED+KEY-1');
		// Outlasts any re-check of the restore, so only an event from this renewal can reveal it.
		await delay(1500);
		await fsp.writeFile(certPath + '.next', 'CERT-2');
		await fsp.rename(certPath + '.next', certPath);
		await waitForLoaded('CERT-2+KEY-1', 3);
		requireLostTracking(this, certPath);
	});

	it('re-reads the restore while unrelated files in its directory keep changing', async function () {
		await watchPair();
		const stopChurn = churnUnrelatedFile();
		try {
			await cancelRenewal(certPath, 'UNMATCHED+KEY-1');
			await waitForLoaded('CERT-1+KEY-1', 3);
		} finally {
			await stopChurn();
		}
		requireLostTracking(this, certPath);
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

	it('attempts a pair whose key is missing once while unrelated files keep changing', async () => {
		await watchPair();
		await fsp.unlink(keyPath);
		await waitForLoaded('CERT-1+MISSING', 2);
		// Outlasts the re-check this removal armed.
		await delay(1500);
		const attempts = loaded.length;
		const stopChurn = churnUnrelatedFile();
		try {
			await delay(2500);
		} finally {
			await stopChurn();
		}
		assert.strictEqual(loaded.length, attempts, `pair without its key re-attempted: ${loaded}`);
	});
});
