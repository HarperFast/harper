'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const fs = require('fs-extra');
const rewire = require('rewire');
const path = require('path');
const env_mgr = require('#src/utility/environment/environmentManager');
const keys = rewire('#src/security/keys');
const { generateSerialNumber } = require('#src/security/keys');
const config_utils = require('#js/config/configUtils');
const mkcert = require('mkcert');
const forge = require('node-forge');
const pki = forge.pki;

describe('Test keys module', () => {
	const sandbox = sinon.createSandbox();
	const test_dir = path.resolve(__dirname, '../envDir/keys-test-' + process.pid + '-' + Date.now());
	const test_cert_path = path.join(test_dir, 'test-certificate.pem');
	const test_ca_path = path.join(test_dir, 'test-ca.pem');
	const test_private_key_path = path.join(test_dir, 'test-private-key.pem');

	let update_config_value_stub;
	let test_private_key;
	let test_cert;
	let test_ca;
	let test_public_key;
	let actual_cert;
	let actual_ca;
	let ca_key;
	let savedCerts = null;
	let root_path;

	before(async function () {
		this.timeout(10000);
		const uniqueOrg = 'Harper-Test-' + Date.now();
		const ca = await mkcert.createCA({
			organization: uniqueOrg + '-CA',
			countryCode: 'USA',
			state: 'Colorado',
			locality: 'Denver',
			validity: 1,
		});

		let cert = await mkcert.createCert({
			domains: [uniqueOrg + '-Cert', '127.0.0.1', 'localhost', '::1'],
			validityDays: 1,
			ca,
		});

		test_private_key = cert.key;
		ca_key = ca.key;
		test_cert = cert.cert;
		test_ca = ca.cert;
		test_public_key = pki.certificateFromPem(ca.cert).publicKey;
		await fs.ensureDir(test_dir);
		await fs.writeFile(test_cert_path, test_cert);
		await fs.writeFile(test_private_key_path, test_private_key);
		await fs.writeFile(test_ca_path, test_ca);

		root_path = test_dir;
		sandbox.stub(config_utils, 'getConfigFromFile').callsFake((key) => {
			if (key === 'tls')
				return {
					certificate: test_cert_path,
					privateKey: test_private_key_path,
					certificateAuthority: test_ca_path,
				};
			if (key === 'rootPath') return root_path;
			return undefined;
		});
		env_mgr.setHdbBasePath(root_path);
		env_mgr.setProperty('storage_path', path.join(test_dir, 'database'));

		const testUtils = require('../testUtils.js');
		testUtils.preTestPrep();
		testUtils.setupTestDBPath();

		const { resetDatabases, databases } = require('#src/resources/databases');
		resetDatabases();

		const mountHdb = require('#src/utility/mount_hdb').default;
		await mountHdb(test_dir);

		if (databases.system?.hdb_certificate) {
			savedCerts = [];
			for await (const cert of databases.system.hdb_certificate.search([])) {
				savedCerts.push({ ...cert });
			}
			await databases.system.hdb_certificate.clear();
			console.log('COUNT BEFORE LOAD CERT:', Array.from(await databases.system.hdb_certificate.search([])).length);
		}

		keys.__set__('configuredCertsLoaded', false);
		keys.__set__('certificateTable', undefined);
		keys.__set__('privateKeys', new Map());

		await keys.loadCertificates();

		const all_certs = await keys.listCertificates();
		all_certs.forEach((cert) => {
			if (!cert.is_authority && cert?.details?.issuer?.includes(uniqueOrg)) {
				actual_cert = cert;
			} else if (cert.name.includes(uniqueOrg)) {
				actual_ca = cert;
			}
		});
	});

	afterEach(() => {
		sandbox.restore();
		sandbox.stub(config_utils, 'getConfigFromFile').callsFake((key) => {
			if (key === 'tls')
				return {
					certificate: test_cert_path,
					privateKey: test_private_key_path,
					certificateAuthority: test_ca_path,
				};
			if (key === 'rootPath') return root_path;
			return undefined;
		});
	});

	after(async () => {
		sandbox.restore();
		await fs.remove(test_dir);
		if (savedCerts !== null) {
			const { databases: dbs } = require('#src/resources/databases');
			if (dbs.system?.hdb_certificate) {
				await dbs.system.hdb_certificate.clear();
				for (const cert of savedCerts) {
					await dbs.system.hdb_certificate.put(cert);
				}
			}
		}
	});

	it('Test loadCertificates loads certs from config file', async () => {
		const all_certs = await keys.listCertificates();
		let private_key_pass = true;
		let cert_pass = false;
		let ca_pass = false;

		expect(actual_cert, 'actual_cert should be defined').to.exist;
		expect(actual_ca, 'actual_ca should be defined').to.exist;

		for (const cert of all_certs) {
			if (cert.certificate === test_private_key) {
				private_key_pass = false;
				break;
			}

			if (cert.name === actual_cert.name && cert.certificate === actual_cert.certificate) cert_pass = true;

			if (cert.name === actual_ca.name && cert.certificate === actual_ca.certificate) ca_pass = true;
		}

		expect(private_key_pass).to.be.true;
		expect(cert_pass).to.be.true;
		expect(ca_pass).to.be.true;
	});

	it('Test getReplicationCert returns the correct cert', async () => {
		const rep_cert = await keys.getReplicationCert();
		expect(rep_cert).to.exist;
		expect(rep_cert.name).to.equal(actual_cert.name);
	});

	it('Test getReplicationCertAuth returns the correct CA', async () => {
		const ca = await keys.getReplicationCertAuth();
		expect(ca).to.exist;
		expect(ca.certificate).to.equal(actual_ca.certificate);
	});

	it('Test generateCertificates happy path', async () => {
		const generateCertificates = keys.__get__('generateCertificates');
		const cert = await generateCertificates(
			pki.privateKeyFromPem(test_private_key),
			test_public_key,
			pki.certificateFromPem(test_ca)
		);
		expect(cert).to.include('BEGIN CERTIFICATE');
	});

	it('Test getCertAuthority happy path', async () => {
		const all = await keys.listCertificates();
		console.log(
			'ALL CERTS:',
			all.map((c) => ({ name: c.name, is_auth: c.is_authority, pk_name: c.private_key_name }))
		);
		console.log('EXPECTED PK NAME:', actual_ca.private_key_name);
		keys.__get__('privateKeys').set(actual_ca.private_key_name, ca_key);
		const getCertAuthority = keys.__get__('getCertAuthority');
		const key_and_cert = await getCertAuthority();
		expect(key_and_cert).to.exist;
		expect(key_and_cert.ca).to.exist;
		keys.__get__('privateKeys').set(actual_ca.private_key_name, test_private_key);
	});

	it('Test reviewSelfSignedCert create a new cert', async () => {
		const set_cert_stub = sandbox.stub(keys, 'setCertTable');
		const get_rep_rw = keys.__set__('getReplicationCert', sandbox.stub().resolves(undefined));
		const get_ca_rw = keys.__set__(
			'getCertAuthority',
			sandbox.stub().resolves({ ca: { certificate: test_ca, private_key_name: 'test' }, private_key: test_private_key })
		);
		const set_cert_rw = keys.__set__('setCertTable', set_cert_stub);
		await keys.reviewSelfSignedCert();
		expect(set_cert_stub.called).to.be.true;
		get_rep_rw();
		set_cert_rw();
		get_ca_rw();
	});

	it('Test updateConfigCert builds new cert config correctly', () => {
		update_config_value_stub = sandbox.stub(config_utils, 'updateConfigValue');
		keys.updateConfigCert('public/cert.pem', 'private/cert.pem', 'certificate/authority.pem');
		const call = update_config_value_stub.getCalls().find((c) => c.args[0] === 'tls' || c.args[2]?.tls_privateKey);
		expect(call).to.exist;
	});

	it('hostnamesFromCert returns the correct hostnames', async () => {
		const test_cert = {
			subject: '',
			subjectAltName: 'DirName:\"CN=test-1.name\\u002cO=1999710\",' + ' DirName:CN=test-2.org,IP-Address:1.2.3.4',
		};
		const hostnames = keys.hostnamesFromCert(test_cert);
		expect(hostnames).to.include('test-1.name');
		expect(hostnames).to.include('test-2.org');
	});

	it('getPrimaryHostName with subject', async () => {
		const test_cert = {
			subject: 'CN=test-1.name',
			subjectAltName: 'DirName:\"CN=test-different',
		};
		expect(keys.getPrimaryHostName(test_cert)).to.eql('test-1.name');
	});

	it('can extract the hostnames from a certificate', async () => {
		const cert = {
			subjectaltname: 'IP Address:127.0.0.1, DNS:localhost, IP Address:0:0:0:0:0:0:0:1',
			subject: { CN: '127.0.0.1', C: 'USA', ST: 'Colorado', L: 'Denver', O: 'Harper, Inc.' },
		};

		const hostnames = await keys.getHostnamesFromCertificate(cert);
		expect(hostnames).to.have.members(['127.0.0.1', 'localhost']);
	});

	it('Test setCertTable with malformed certificate - illegal ASN.1 padding', async () => {
		const { databases } = require('#src/resources/databases');
		keys.__set__('certificateTable', databases.system.hdb_certificate);

		const malformedCerts = [
			{
				name: 'corrupted-base64-padding',
				certificate: '-----BEGIN CERTIFICATE-----\nMIIEFzCCAv+gAwIBAgIUBg==\n-----END CERTIFICATE-----',
			},
		];

		for (const malformedCert of malformedCerts) {
			let error;
			try {
				await keys.setCertTable(malformedCert);
			} catch (err) {
				error = err;
			}
			expect(error).to.exist;
			expect(error.code).to.equal('INVALID_CERTIFICATE_FORMAT');
		}
	});

	describe('generateSerialNumber', () => {
		it('should generate valid hex serial numbers', () => {
			const serial = generateSerialNumber();
			expect(serial).to.be.a('string');
			expect(serial).to.match(/^[0-9a-f]{16}$/);
		});
	});

	it('Test setCertTable with valid certificate should work', async () => {
		const { databases } = require('#src/resources/databases');
		keys.__set__('certificateTable', databases.system.hdb_certificate);

		const validCert = {
			name: 'valid-test-cert',
			certificate: test_cert,
			uses: ['https'],
			is_authority: false,
			private_key_name: 'test.pem',
		};

		await keys.setCertTable(validCert);
		const certs = await keys.listCertificates();
		const found = certs.find((c) => c.name === 'valid-test-cert');
		expect(found).to.exist;
	});

	it('Test generateCertAuthority includes subjectKeyIdentifier extension for OCSP support', async () => {
		const generateCertAuthority = keys.__get__('generateCertAuthority');
		const { privateKey, publicKey } = await keys.generateKeys();
		const caCert = await generateCertAuthority(privateKey, publicKey, false);
		const extensions = caCert.extensions;
		const hasSubjectKeyIdentifier = extensions.some((ext) => ext.name === 'subjectKeyIdentifier');
		expect(hasSubjectKeyIdentifier).to.be.true;
	});

	it('createTLSSelector resolves when cert.uses is stored as a non-array', async () => {
		// Regression: cert.uses stored as a non-array (e.g. a scalar without .includes)
		// caused a TypeError inside createTLSSelector's per-cert quality-scoring block.
		// The fix normalizes cert.uses to an array before calling .includes/.length.
		const { databases } = require('#src/resources/databases');

		const testCertName = 'test-non-array-uses-' + Date.now();
		await databases.system.hdb_certificate.put({
			name: testCertName,
			certificate: test_cert,
			uses: 'https', // string, not array — legacy/manual entry format
			is_authority: false,
			private_key_name: actual_cert.private_key_name,
			is_self_signed: true,
		});

		let thrownError;
		try {
			const selector = keys.createTLSSelector('https');
			await selector.initialize(null);
		} catch (err) {
			thrownError = err;
		} finally {
			await databases.system.hdb_certificate.delete(testCertName);
		}

		expect(thrownError, 'createTLSSelector must not throw for cert with non-array uses').to.be.undefined;
	});

	describe('private-key hot-reload triggers a TLS context rebuild', () => {
		// handlePrivateKeyReload is the single chokepoint for both the chokidar watcher and the
		// periodic poll. On a worker, the new cert arrives via the hdb_certificate subscription, but
		// the key only lands in the in-thread privateKeys map — without a rebuild the worker keeps a
		// secure context pairing the new cert with the old key. These tests pin the rotation guard
		// (the part that decides whether a reload triggers a rebuild) directly.
		let privateKeysMap;
		let liveTLSRebuilders;
		let handlePrivateKeyReload;
		let spy;
		let keyName;

		beforeEach(() => {
			privateKeysMap = keys.__get__('privateKeys');
			liveTLSRebuilders = keys.__get__('liveTLSRebuilders');
			handlePrivateKeyReload = keys.__get__('handlePrivateKeyReload');
			keyName = 'unit-key-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.pem';
			spy = sinon.spy();
			liveTLSRebuilders.add(spy);
		});

		afterEach(() => {
			liveTLSRebuilders.delete(spy);
			privateKeysMap.delete(keyName);
		});

		it('rebuilds on the initial load of a key (recovery: key appears/restored after boot)', () => {
			// At normal startup liveTLSRebuilders is empty so this is a no-op; once selectors are
			// registered (modeled here by the spy), a key that first appears must rebuild or the
			// worker would stay stranded on a context built without it.
			handlePrivateKeyReload(keyName, 'KEY-A');
			expect(privateKeysMap.get(keyName)).to.equal('KEY-A');
			expect(spy.calledOnce, 'first appearance of a key must trigger a rebuild when rebuilders exist').to.be.true;
		});

		it('rebuilds when the key rotates to a new value', () => {
			privateKeysMap.set(keyName, 'KEY-A');
			handlePrivateKeyReload(keyName, 'KEY-B');
			expect(privateKeysMap.get(keyName)).to.equal('KEY-B');
			expect(spy.calledOnce, 'a rotated key must trigger exactly one rebuild fan-out').to.be.true;
		});

		it('does not rebuild when the reloaded key is unchanged', () => {
			privateKeysMap.set(keyName, 'KEY-A');
			handlePrivateKeyReload(keyName, 'KEY-A');
			expect(spy.called, 'an identical-content reload must not trigger a rebuild').to.be.false;
		});
	});

	describe('createTLSSelector live-reload registration', () => {
		// Live server selectors must register for key-rotation rebuilds; transient single-use
		// selectors (getReplicationCert) must not, or they would accumulate in the registry.
		it('registers a rebuilder for a live selector but not for a transient one', async () => {
			const liveTLSRebuilders = keys.__get__('liveTLSRebuilders');
			const snapshot = [...liveTLSRebuilders];
			try {
				const transient = keys.createTLSSelector('https', undefined, false);
				await transient.initialize(null);
				expect(liveTLSRebuilders.size, 'transient selector must not register').to.equal(snapshot.length);

				const live = keys.createTLSSelector('https');
				await live.initialize(null);
				expect(liveTLSRebuilders.size, 'live selector must register exactly one rebuilder').to.equal(
					snapshot.length + 1
				);
			} finally {
				// Drop any rebuilders added by this test so later tests aren't perturbed.
				liveTLSRebuilders.clear();
				snapshot.forEach((r) => liveTLSRebuilders.add(r));
			}
		});
	});

	describe('certificate file_timestamp staleness guard', () => {
		let certTable;
		let certCn;
		let originalMtime;
		let originalRecord;

		// Re-run a single load cycle against the existing (seeded) certificate table.
		async function reloadCertificates() {
			keys.__set__('configuredCertsLoaded', false);
			keys.__set__('certificateTable', undefined);
			await keys.loadCertificates();
		}

		before(async () => {
			const { databases } = require('#src/resources/databases');
			certTable = databases.system.hdb_certificate;
			certCn = actual_cert.name;
			// These tests mutate the cert file mtime and the stored record; snapshot both so we
			// can restore them and avoid polluting state for any later-added tests.
			originalMtime = fs.statSync(test_cert_path).mtime;
			originalRecord = { ...(await certTable.get(certCn)) };
		});

		beforeEach(() => {
			// loadCertificates() returns only the last processed cert's put promise. Drop the
			// certificateAuthority from the config so the non-CA cert is the awaited write,
			// guaranteeing reloadCertificates() resolves after certCn is committed.
			sandbox.restore();
			sandbox.stub(config_utils, 'getConfigFromFile').callsFake((key) => {
				if (key === 'tls')
					return {
						certificate: test_cert_path,
						privateKey: test_private_key_path,
					};
				if (key === 'rootPath') return root_path;
				return undefined;
			});
		});

		after(async () => {
			fs.utimesSync(test_cert_path, originalMtime, originalMtime);
			await certTable.put(originalRecord);
		});

		it('persists file_timestamp matching the certificate file mtime on load', async () => {
			const record = await certTable.get(certCn);
			const mtimeMs = fs.statSync(test_cert_path).mtimeMs;
			expect(record.file_timestamp, 'file_timestamp should be persisted on the record').to.equal(mtimeMs);
		});

		it('reloads the certificate when the file is newer than the stored record', async () => {
			const past = Date.now() - 24 * 60 * 60 * 1000;
			await certTable.put({
				...(await certTable.get(certCn)),
				name: certCn,
				certificate: 'SENTINEL-OLD',
				is_self_signed: false,
				file_timestamp: past,
			});
			const now = new Date();
			fs.utimesSync(test_cert_path, now, now);

			await reloadCertificates();

			const record = await certTable.get(certCn);
			expect(record.certificate, 'a newer file should overwrite the stored cert').to.not.equal('SENTINEL-OLD');
			expect(record.file_timestamp, 'file_timestamp should advance to the file mtime').to.equal(
				fs.statSync(test_cert_path).mtimeMs
			);
		});

		it('skips reload when the certificate file is older than the stored record', async () => {
			// The stored record claims a file_timestamp far in the future, while the file mtime is
			// set newer than "now" but still older than that record. This distinguishes reading
			// file_timestamp (correct -> skip) from falling back to __updatedtime__ (~now -> reload).
			const future = Date.now() + 24 * 60 * 60 * 1000;
			await certTable.put({
				...(await certTable.get(certCn)),
				name: certCn,
				certificate: 'SENTINEL-FUTURE',
				is_self_signed: false,
				file_timestamp: future,
			});
			const fileTime = new Date(Date.now() + 60 * 60 * 1000);
			fs.utimesSync(test_cert_path, fileTime, fileTime);

			await reloadCertificates();

			const record = await certTable.get(certCn);
			expect(record.certificate, 'an older file must not overwrite the stored cert').to.equal('SENTINEL-FUTURE');
		});
	});

	describe('loadAndWatch periodic re-read safety net (#586)', () => {
		const loadAndWatch = keys.__get__('loadAndWatch');
		const watchTimers = keys.__get__('certificateWatchTimers');
		const watchPollers = keys.__get__('certificateWatchPollers');
		const localSandbox = sinon.createSandbox();
		let watchPath;

		beforeEach(() => {
			// Stub chokidar's watch so these tests exercise only the poll path and never open a real
			// FSWatcher (real watchers would leak fds and risk EMFILE across repeated runs).
			const chokidar = require('chokidar');
			localSandbox.stub(chokidar, 'watch').returns({ on: () => {} });
			watchPath = path.join(test_dir, `watch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pem`);
			fs.writeFileSync(watchPath, 'PEM-V1');
		});

		afterEach(() => {
			localSandbox.restore();
			const timer = watchTimers.get(watchPath);
			if (timer) clearInterval(timer);
			watchTimers.delete(watchPath);
			watchPollers.delete(watchPath);
			if (fs.existsSync(watchPath)) fs.removeSync(watchPath);
		});

		it('a cert swap missed by inotify is still picked up by the poll (mtime advanced)', () => {
			const loaded = [];
			loadAndWatch(watchPath, (pem) => loaded.push(pem), 'certificate');

			// Initial synchronous load on registration.
			expect(loaded).to.eql(['PEM-V1']);

			// Simulate a renewal that inotify missed: new content + advanced mtime, no chokidar event.
			fs.writeFileSync(watchPath, 'PEM-V2');
			const future = (Date.now() + 5000) / 1000;
			fs.utimesSync(watchPath, future, future);

			// Drive a single poll (what the unref'd interval would do on its tick).
			watchPollers.get(watchPath)();

			expect(loaded).to.eql(['PEM-V1', 'PEM-V2']);
		});

		it("chokidar's 'change' event reloads even when it emits no stats (alwaysStat off)", () => {
			// chokidar v4 defaults alwaysStat:false, so the 'change' handler is called with undefined
			// stats; loadFile must stat the file itself rather than throw and silently skip the reload.
			let changeHandler;
			localSandbox.restore();
			const chokidar = require('chokidar');
			localSandbox.stub(chokidar, 'watch').returns({
				on: (event, handler) => {
					if (event === 'change') changeHandler = handler;
				},
			});

			const loaded = [];
			loadAndWatch(watchPath, (pem) => loaded.push(pem), 'certificate');
			expect(loaded).to.eql(['PEM-V1']);

			fs.writeFileSync(watchPath, 'PEM-V2');
			const future = (Date.now() + 5000) / 1000;
			fs.utimesSync(watchPath, future, future);

			// Fire the watcher's change event the way chokidar does when alwaysStat is off: no stats.
			changeHandler(watchPath, undefined);

			expect(loaded).to.eql(['PEM-V1', 'PEM-V2']);
		});

		it('does not reload when the file is unchanged (mtime fingerprint dedup)', () => {
			const loaded = [];
			loadAndWatch(watchPath, (pem) => loaded.push(pem), 'certificate');
			expect(loaded).to.eql(['PEM-V1']);

			// Repeated polls with no on-disk change must not re-invoke the loader.
			const poll = watchPollers.get(watchPath);
			poll();
			poll();
			expect(loaded).to.eql(['PEM-V1']);
		});

		it('resolves the configured interval and registers an unref-ed poll timer', () => {
			localSandbox.stub(env_mgr, 'get').callsFake((param) => {
				if (param === 'tls_certificateWatchInterval') return 1234;
				return undefined;
			});

			expect(keys.__get__('getCertificateWatchInterval')()).to.equal(1234);

			loadAndWatch(watchPath, () => {}, 'certificate');

			const timer = watchTimers.get(watchPath);
			expect(timer, 'a poll timer should be registered').to.exist;
			// .unref() prevents the timer from holding the event loop / process open.
			expect(typeof timer.unref).to.equal('function');
			expect(timer.hasRef()).to.be.false;
		});

		it('falls back to the default interval when unconfigured or invalid', () => {
			const getCertificateWatchInterval = keys.__get__('getCertificateWatchInterval');
			const DEFAULT = keys.__get__('DEFAULT_CERTIFICATE_WATCH_INTERVAL_MS');
			const stub = localSandbox.stub(env_mgr, 'get');
			stub.callsFake(() => undefined);
			expect(getCertificateWatchInterval()).to.equal(DEFAULT);
			stub.callsFake(() => 'not-a-number');
			expect(getCertificateWatchInterval()).to.equal(DEFAULT);
			stub.callsFake(() => -5);
			expect(getCertificateWatchInterval()).to.equal(DEFAULT);
		});

		it('registers a poll for a private-key watch (key poll must run on all threads, including workers)', () => {
			// Private keys are loaded per-thread directly from disk (no hdb_certificate propagation), so
			// the poll safety net must be wired for 'private key' watches regardless of thread. On the
			// main thread the poller is registered either way; this asserts the key path stays wired.
			loadAndWatch(watchPath, () => {}, 'private key');
			expect(watchPollers.get(watchPath), 'a poller should be registered for the private key').to.exist;
		});

		it('does not register a poll timer when the interval is configured to 0', () => {
			localSandbox.stub(env_mgr, 'get').callsFake((param) => {
				if (param === 'tls_certificateWatchInterval') return 0;
				return undefined;
			});

			loadAndWatch(watchPath, () => {}, 'certificate');

			expect(watchTimers.get(watchPath), 'no timer should be registered when polling is disabled').to.be.undefined;
		});
	});
});
