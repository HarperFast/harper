'use strict';

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

// chokidar throttles a path's removal for 100 ms. A cancelled renewal that removes the path again inside that
// window loses the second removal, and chokidar keeps tracking the name on the deleted inode: it emits no
// add/change for the restore or for any later replacement of that path.
describe('TLS file watch after a cancelled renewal', () => {
	const realWatch = chokidar.default.watch;
	let previousInterval;
	let watchDir;
	let certPath;
	let keyPath;
	let watchers;
	let loaded;

	before(() => {
		previousInterval = env.get(CONFIG_PARAMS.TLS_CERTIFICATEWATCHINTERVAL);
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
		fs.rmSync(watchDir, { recursive: true, force: true });
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

	async function cancelRenewal(filePath, unmatchedPair) {
		const savedPath = filePath + '.saved';
		await fsp.rename(filePath, savedPath);
		await fsp.writeFile(filePath, 'UNMATCHED');
		await waitFor(() => loaded.at(-1) === unmatchedPair, {
			timeout: 5000,
			interval: 1,
			message: `the unmatched pair was never loaded: ${loaded}`,
		});
		await fsp.unlink(filePath);
		await fsp.rename(savedPath, filePath);
	}

	function expectLoaded(pair, loadCount) {
		return waitFor(() => loaded.at(-1) === pair && loaded.length >= loadCount, {
			timeout: 5000,
			message: `${pair} was never loaded: ${loaded}`,
		});
	}

	it('re-reads a certificate restored right after an unmatched one', async () => {
		await watchPair();
		await cancelRenewal(certPath, 'UNMATCHED+KEY-1');
		await expectLoaded('CERT-1+KEY-1', 3);
	});

	it('re-reads a private key restored right after an unmatched one', async () => {
		await watchPair();
		await cancelRenewal(keyPath, 'CERT-1+UNMATCHED');
		await expectLoaded('CERT-1+KEY-1', 3);
	});

	it('reads a renewal installed after the cancelled one has settled', async () => {
		await watchPair();
		await cancelRenewal(certPath, 'UNMATCHED+KEY-1');
		// Outlasts any re-check of the restore, so only an event from this renewal can reveal it.
		await delay(1500);
		await fsp.writeFile(certPath + '.next', 'CERT-2');
		await fsp.rename(certPath + '.next', certPath);
		await expectLoaded('CERT-2+KEY-1', 3);
	});

	it('re-reads the restore while unrelated files in its directory keep changing', async () => {
		await watchPair();
		const churnPath = path.join(watchDir, 'unrelated.log');
		let churning = true;
		const churn = (async () => {
			while (churning) {
				await fsp.appendFile(churnPath, 'x');
				await delay(20);
			}
		})();
		try {
			await cancelRenewal(certPath, 'UNMATCHED+KEY-1');
			await expectLoaded('CERT-1+KEY-1', 3);
		} finally {
			churning = false;
			await churn;
		}
	});
});
