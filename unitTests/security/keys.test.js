'use strict';

const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const assert = require('node:assert');
const fs = require('fs-extra');
const rewire = require('rewire');
const path = require('path');
const env_mgr = require('#src/utility/environment/environmentManager');
const keys = rewire('#src/security/keys');
const { generateSerialNumber } = require('#src/security/keys');
const config_utils = require('#src/config/configUtils');
const mkcert = require('mkcert');
const forge = require('node-forge');
const pki = forge.pki;
const { waitFor } = require('../waitFor.js');

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

	it('skips an unparseable certificate record instead of aborting the whole pass', async () => {
		// Regression: the CA-collection loop parsed every row's `certificate` with no per-row guard,
		// so one bad record threw before any secure context was built — the second loop's per-cert
		// try/catch doesn't cover this loop. One bad row shouldn't empty the listener's context map.
		const { databases } = require('#src/resources/databases');

		const badCertName = 'test-unparseable-cert-' + Date.now();
		await databases.system.hdb_certificate.put({
			name: badCertName,
			certificate: 'not a real certificate',
			uses: [],
			is_authority: false,
			private_key_name: actual_cert.private_key_name,
			is_self_signed: true,
		});

		let thrownError;
		let selector;
		try {
			selector = keys.createTLSSelector('https');
			await selector.initialize(null);
		} catch (err) {
			thrownError = err;
		} finally {
			await databases.system.hdb_certificate.delete(badCertName);
		}

		expect(thrownError, 'createTLSSelector must not reject for an unparseable certificate record').to.be.undefined;
		expect(selector.defaultContext, 'the valid certificate must still be applied').to.exist;
	});

	describe('createTLSSelector certificate-selection priority for usageType (regression for #2003 review)', () => {
		// The resolveEffectiveTlsCiphers allowlist test above only proves cipher/@SECLEVEL
		// relevance — it would still pass if MQTT stopped forwarding usageType, or if
		// createTLSSelector stopped giving uses:['mqtt'] exact-match priority / uses:['server']
		// fallback credit. These exercise the actual certificate-selection path (SNICallback)
		// with overlapping certificates for one hostname, so that regression fails here instead.
		const { databases } = require('#src/resources/databases');
		// A hostname outside test_cert's real SANs, given explicitly via `hostnames` below (the
		// code honors `cert.hostnames ?? hostnamesFromCert(certParsed)`) — this keeps every
		// candidate's quality a clean, hostname-bonus-free number, AND lets the decoy below (which
		// keeps test_cert's real SANs, so it never registers under this key) prove the per-hostname
		// SNI map is what's actually being exercised, not just the global `defaultContext` fallback.
		const hostname = 'mqtt-2003-review.invalid';

		async function withCerts(certs, fn) {
			try {
				for (const cert of certs) {
					await databases.system.hdb_certificate.put({
						certificate: test_cert,
						is_authority: false,
						private_key_name: actual_cert.private_key_name,
						// is_self_signed: true (base quality 1) for the `hostname`-scoped candidates below,
						// vs. `decoy()`'s false (base quality 3) — deliberately different tiers so the
						// decoy's superiority over the intended winner doesn't depend on the +0.1
						// hostname-match bonus (getHost() case-sensitivity makes that bonus environment-
						// dependent; verified during review that it can silently vanish on another host).
						is_self_signed: true,
						...cert,
					});
				}
				return await fn();
			} finally {
				for (const cert of certs) {
					await databases.system.hdb_certificate.delete(cert.name).catch(() => {});
				}
			}
		}

		// Resolves { name, quality } rather than just the winning name — quality > existingQuality
		// (strict) means a tie is broken by hdb_certificate scan order, not by intent, so asserting
		// the margin (not only who happened to win) keeps a future tie from reading as a pass here.
		function chosenCert(selector, host) {
			return new Promise((resolve, reject) => {
				selector(host, (err, context) =>
					err ? reject(err) : resolve(context && { name: context.name, quality: context.quality })
				);
			});
		}

		// Globally the best-quality certificate in the whole table — is_self_signed: false (base 3,
		// vs. the hostname-scoped candidates' 1) plus the exact-match bonus (+3) gives it quality 6,
		// unambiguously ahead of the highest possible `hostname`-scoped quality (4) regardless of
		// whether the +0.1 getHost() bonus also applies. Real test_cert SANs, so it never registers
		// under the synthetic `hostname` — it must never win a lookup for `hostname`. If it does, the
		// SNICallback fell through to `defaultContext` instead of using the per-hostname SNI map,
		// which is exactly the failure mode a broken `hostnames` assignment would produce.
		function decoy(name) {
			return { name, uses: ['mqtt'], is_self_signed: false };
		}

		it('an MQTT selector chooses the mqtt-tagged certificate over a legacy server-tagged or generic certificate for the same hostname', async () => {
			await withCerts(
				[
					{ name: 'sel-mqtt-tagged-' + Date.now(), uses: ['mqtt'], hostnames: [hostname] },
					{ name: 'sel-server-tagged-' + Date.now(), uses: ['server'], hostnames: [hostname] },
					{ name: 'sel-generic-' + Date.now(), uses: [], hostnames: [hostname] },
					decoy('sel-decoy-' + Date.now()),
				],
				async () => {
					// liveReload: false keeps these out of liveTLSRebuilders (the default would leak a
					// rebuild registration per test); the hdb_certificate subscription itself is retained
					// regardless — that's a pre-existing createTLSSelector characteristic, not something
					// this arg controls.
					const selector = keys.createTLSSelector('mqtt', undefined, false);
					await selector.initialize(null);
					const chosen = await chosenCert(selector, hostname);
					expect(chosen.name).to.include('sel-mqtt-tagged-');
					// base quality 1 (is_self_signed: true) + 3 for the uses:['mqtt'] exact match, no
					// hostname bonus (this candidate's `hostnames` is the synthetic one, not test_cert's
					// real SANs) — asserting the value, not just the winning name, means a future tie
					// reads as a failure here too.
					expect(chosen.quality).to.equal(4);
					// Confirm the decoy (quality 6, deterministically > 4 regardless of environment — see
					// withCerts) is genuinely the whole table's defaultContext. This is what makes the
					// assertion above meaningful: if the per-hostname map fell through to defaultContext,
					// `chosen` would be the decoy, not the mqtt-tagged winner.
					expect(selector.defaultContext?.name).to.include('sel-decoy-');
				}
			);
		});

		it('the legacy server-tagged fallback remains eligible for MQTT when no mqtt-tagged certificate exists', async () => {
			await withCerts(
				[
					{ name: 'sel-server-fallback-' + Date.now(), uses: ['server'], hostnames: [hostname] },
					{ name: 'sel-generic-2-' + Date.now(), uses: [], hostnames: [hostname] },
					decoy('sel-decoy-2-' + Date.now()),
				],
				async () => {
					// liveReload: false keeps these out of liveTLSRebuilders (the default would leak a
					// rebuild registration per test); the hdb_certificate subscription itself is retained
					// regardless — that's a pre-existing createTLSSelector characteristic, not something
					// this arg controls.
					const selector = keys.createTLSSelector('mqtt', undefined, false);
					await selector.initialize(null);
					const chosen = await chosenCert(selector, hostname);
					expect(chosen.name).to.include('sel-server-fallback-');
					// base quality 1 + 0.5 legacy-fallback credit, strictly ahead of the generic
					// candidate's 1.
					expect(chosen.quality).to.equal(1.5);
					// See the test above: the decoy (quality 6, deterministically > 1.5) is asserted as
					// defaultContext directly, so a per-hostname-map fall-through is distinguishable from
					// a real SNI-map hit.
					expect(selector.defaultContext?.name).to.include('sel-decoy-2-');
				}
			);
		});
	});

	describe('threadServer onSocket — usageType handoff (regression for #2003 review)', () => {
		// The two describe blocks above cover each END of the usageType contract: mqtt.ts emits
		// `usageType: 'mqtt'` (unitTests/server/mqtt.test.js), and createTLSSelector('mqtt', ...)
		// honors it (above, via the `keys` module this file `rewire()`s). The SEAM —
		// threadServer.js's `const usageType = options.usageType ?? 'server'`, which feeds BOTH
		// createTLSSelector and getEffectiveTlsCiphers — had no coverage; a revert to a hardcoded
		// 'server' there left every other test green (confirmed by mutation during review).
		//
		// `server/threads/threadServer.js` imports security/keys.ts via a plain `require`, NOT
		// this file's `rewire()`'d instance — those are two separate module instances with their
		// own `privateKeys` maps. Calling the plain-required instance's own `loadCertificates()`
		// (below) populates *its* map from the same on-disk test key file the rewired instance
		// already uses (same `config_utils.getConfigFromFile` stub, shared across both instances),
		// so `onSocket`'s real `createTLSSelector` call can actually build secure contexts instead
		// of every candidate throwing "Missing private key" and being silently swallowed.
		//
		// The requires themselves are deferred into `before()` rather than sitting in the describe
		// body: describe bodies run at mocha's *load* phase, before this file's own top-level
		// `before()` (env_mgr.setHdbBasePath, testUtils.preTestPrep, etc.) has run — and
		// threadServer.js calls env.initSync() at module load, which would otherwise read whatever
		// real Harper config happens to exist on the machine running the suite.
		let server, databases, SERVERS, portServer, realKeys;
		// tls.createServer validates `ciphers` against OpenSSL's real cipher list at construction
		// time, so these must be distinct, valid suite names, not arbitrary strings.
		const rootCiphers = 'AES128-SHA';
		const opsCiphers = 'AES256-SHA';
		const seamHost = 'mqtt-2003-seam.invalid';
		let nextPort = 40000 + (process.pid % 1000);
		const createdServers = [];
		let previousTls;
		let previousOpsTls;
		let previousUds;

		before(async () => {
			({ server } = require('#src/server/Server'));
			require('#src/server/threads/threadServer'); // side effect: registers server.socket = onSocket
			({ databases } = require('#src/resources/databases'));
			({ SERVERS, portServer } = require('#src/server/serverRegistry'));
			realKeys = require('#src/security/keys');
			await realKeys.loadCertificates();
			previousTls = env_mgr.get('tls');
			previousOpsTls = env_mgr.get('operationsApi_tls');
			previousUds = env_mgr.get('tls_unixDomainSockets');
			env_mgr.setProperty('tls', { ...previousTls, ciphers: rootCiphers });
			env_mgr.setProperty('operationsApi_tls', { ...previousOpsTls, ciphers: opsCiphers });
			// onSocket takes a second, UDS-mirror code path when this is enabled (creates and
			// registers a second live server per call, with its own cleanup this block doesn't do).
			// Forcing it off keeps this describe's cleanup exhaustive regardless of the host's config.
			env_mgr.setProperty('tls_unixDomainSockets', false);
		});

		after(() => {
			env_mgr.setProperty('tls', previousTls);
			env_mgr.setProperty('operationsApi_tls', previousOpsTls);
			env_mgr.setProperty('tls_unixDomainSockets', previousUds);
			for (const created of createdServers) {
				created.close();
				delete SERVERS[created.securePort];
				portServer.delete(created.securePort);
			}
		});

		function socket(options) {
			const securePort = nextPort++;
			const socketServer = server.socket(() => {}, { securePort, ...options });
			createdServers.push({ close: () => socketServer.close?.(), securePort });
			return socketServer;
		}

		it("applies the operationsApi.tls layer only when usageType is 'operations-api'", () => {
			expect(socket({ usageType: 'operations-api' }).appliedCiphers).to.equal(opsCiphers);
		});

		it("falls back to the root tls layer for a non-operations-api usageType (e.g. 'mqtt')", () => {
			expect(socket({ usageType: 'mqtt' }).appliedCiphers).to.equal(rootCiphers);
		});

		it('threads usageType into createTLSSelector too — an mqtt-tagged cert outranks a server-tagged one on the real listener', async () => {
			const certs = [
				{ name: 'seam-mqtt-' + Date.now(), uses: ['mqtt'], hostnames: [seamHost] },
				{ name: 'seam-server-' + Date.now(), uses: ['server'], hostnames: [seamHost] },
			];
			try {
				for (const cert of certs) {
					await databases.system.hdb_certificate.put({
						certificate: test_cert,
						is_authority: false,
						private_key_name: actual_cert.private_key_name,
						is_self_signed: false,
						...cert,
					});
				}
				const socketServer = socket({ usageType: 'mqtt' });
				const winner = socketServer.secureContexts.get(seamHost);
				expect(winner?.name).to.include('seam-mqtt-');
				expect(winner?.quality).to.equal(6);
			} finally {
				for (const cert of certs) await databases.system.hdb_certificate.delete(cert.name).catch(() => {});
			}
		});
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

	describe('createTLSSelector when the system database is not yet loaded on this thread', () => {
		// A raw-socket listener (e.g. MQTT's securePort) can initialize its own TLS selector before
		// this thread has loaded the system database — selector creation doesn't control
		// component/database load order. Before this fix, that raced the (unguarded)
		// `databases.system.hdb_certificate.subscribe(...)` call inside the selector's init promise,
		// throwing synchronously and rejecting `.ready` before the rebuilder was ever registered —
		// stranding the selector on an empty cert list with no path to recover except an unrelated
		// private-key hot-reload elsewhere in the process. `databases.system` is defined via a
		// `configurable: true` property (see resources/databases.ts), so it can be deleted/restored
		// here to model that race against the real, shared module (a rewired local doesn't work: the
		// compiled import isn't a reboundable local binding).
		let databases;
		let systemDescriptor;

		beforeEach(() => {
			databases = require('#src/resources/databases').databases;
			systemDescriptor = Object.getOwnPropertyDescriptor(databases, 'system');
		});

		afterEach(() => {
			delete databases.system;
			Object.defineProperty(databases, 'system', systemDescriptor);
		});

		it('keeps `.ready` pending while the system database has not loaded, then resolves with real certs once it does', async function () {
			// `.ready` is a one-shot gate: server/threads/threadServer.js's Bun listener path awaits it
			// exactly once and treats a resolved promise as "TLS decided" — if it resolved here with no
			// certs available, a listener configured as secure would start in plaintext for the rest of
			// the process. So the fix must not just avoid throwing; it must also leave `.ready` PENDING
			// while the race is unresolved, only settling once a real pass (with the table loaded)
			// completes. This uses the real (debounced, ~1.5s) retry and real timers — no Sinon fake
			// timers, no rewire access to internal state — condition-waiting on the actual observable
			// transition instead. liveReload=false so this test's selector never registers with the
			// module-level liveTLSRebuilders registry — a real selector (e.g. MQTT's) always defaults
			// to true, but that registration isn't part of what this race is about, and leaving it true
			// here would leak scheduleRebuild (and this test's pseudoServer/caCerts interaction) into
			// every later test's private-key-reload rebuilds for the rest of the suite.
			this.timeout(5000);
			delete databases.system; // as on a worker thread before the system db has loaded
			const pseudoServer = { secureContexts: null, secureContextsListeners: [] };

			const selector = keys.createTLSSelector('mqtt', undefined, false);
			const readyPromise = selector.initialize(pseudoServer);

			let settled = false;
			readyPromise.then(
				() => (settled = true),
				() => (settled = true)
			);
			await new Promise((resolve) => setImmediate(resolve)); // flush pending microtasks/macrotasks once
			assert.strictEqual(pseudoServer.secureContexts.size, 0, 'no certs are available yet');
			assert.strictEqual(
				settled,
				false,
				'.ready must stay pending while the system database has not loaded — resolving it with no ' +
					'certs would let a caller (e.g. the Bun listener path) start a secure listener as plaintext'
			);

			// the table becomes available; let the real debounced retry fire and observe a real resolution
			Object.defineProperty(databases, 'system', systemDescriptor);
			await waitFor(() => settled, {
				timeout: 4000,
				message: '.ready never resolved after the system database became available',
			});
			// A recovery that resolved with the table still empty (e.g. a race in restoring the
			// property) would satisfy "settled" without actually fixing the incident being tested.
			assert.ok(
				pseudoServer.secureContexts.size > 0,
				"the real cert table (loaded in this suite's before()) must populate secureContexts once recovered"
			);
		});

		it('also retries (without throwing or resolving early) when `databases.system` exists but `hdb_certificate` is not yet attached to it', async function () {
			// The production guard checks `databases.system?.hdb_certificate === undefined`, not just
			// `databases.system === undefined` — the system database object and its hdb_certificate
			// table can become available at different times. A regression that only handled the
			// whole-`system`-missing case would still throw/strand here.
			this.timeout(5000);
			const realHdbCertificate = databases.system.hdb_certificate;
			delete databases.system.hdb_certificate;
			const pseudoServer = { secureContexts: null, secureContextsListeners: [] };
			try {
				const selector = keys.createTLSSelector('mqtt', undefined, false);
				const readyPromise = selector.initialize(pseudoServer);

				let settled = false;
				readyPromise.then(
					() => (settled = true),
					() => (settled = true)
				);
				await new Promise((resolve) => setImmediate(resolve));
				assert.strictEqual(
					settled,
					false,
					'.ready must stay pending while hdb_certificate is not yet attached to databases.system'
				);

				databases.system.hdb_certificate = realHdbCertificate;
				await waitFor(() => settled, {
					timeout: 4000,
					message: '.ready never resolved after hdb_certificate became available',
				});
				assert.ok(
					pseudoServer.secureContexts.size > 0,
					'the real cert table must populate secureContexts once recovered'
				);
			} finally {
				databases.system.hdb_certificate = realHdbCertificate;
			}
		});
	});

	describe('createTLSSelector when a completed pass resolves zero certificates', () => {
		// The not-yet-loaded guard above only covers the table object being absent, not the table
		// being present but every row failing to apply (e.g. a private key not synced to this thread
		// yet). Before this fix, that resolved `.ready` with an empty cert list — the exact
		// customer-visible symptom this PR exists to fix.
		let databases;
		let liveTLSRebuilders;
		let rebuildersSnapshot;
		let searchStub;

		beforeEach(() => {
			databases = require('#src/resources/databases').databases;
			liveTLSRebuilders = keys.__get__('liveTLSRebuilders');
			rebuildersSnapshot = [...liveTLSRebuilders];
			searchStub = sandbox.stub(databases.system.hdb_certificate, 'search').returns([]);
		});

		afterEach(() => {
			searchStub.restore();
			liveTLSRebuilders.clear();
			rebuildersSnapshot.forEach((r) => liveTLSRebuilders.add(r));
		});

		it('retries (does not resolve) for a live selector, then resolves with real certs once a rebuild sees them', async function () {
			this.timeout(5000);
			const pseudoServer = { secureContexts: null, secureContextsListeners: [] };

			const selector = keys.createTLSSelector('mqtt', undefined, true);
			const readyPromise = selector.initialize(pseudoServer);

			let settled = false;
			readyPromise.then(
				() => (settled = true),
				() => (settled = true)
			);
			await new Promise((resolve) => setImmediate(resolve));
			assert.strictEqual(pseudoServer.secureContexts.size, 0, 'no certs resolved from the stubbed empty search');
			assert.strictEqual(
				settled,
				false,
				'.ready must stay pending when a completed pass resolves zero certificates — resolving here would ' +
					'publish an empty certificates list, the exact symptom this PR fixes'
			);

			searchStub.restore(); // the next rebuild sees the real (non-empty) cert table
			await waitFor(() => settled, {
				timeout: 4000,
				message: '.ready never resolved after a rebuild saw real certificates',
			});
			assert.ok(
				pseudoServer.secureContexts.size > 0,
				'the real cert table must populate secureContexts once recovered'
			);
		});

		it('does not retry for a transient (liveReload=false) selector — e.g. getReplicationCert must not hang waiting for a cert it is about to create', async () => {
			const pseudoServer = { secureContexts: null, secureContextsListeners: [] };

			const selector = keys.createTLSSelector('replication', undefined, false);
			await selector.initialize(pseudoServer);

			assert.strictEqual(
				pseudoServer.secureContexts.size,
				0,
				'transient selectors must resolve immediately with an empty result, not retry forever — the ' +
					'bootstrap flow that creates the first replication cert depends on this resolving falsy'
			);
		});

		it('retries on a LATER rebuild that transiently resolves zero certificates — a prior success must not disarm the guard', async function () {
			// The guard must key off "did THIS pass produce anything", not the persistent
			// `defaultContext` closure variable: that is never reset (a transient zero-cert pass keeps
			// serving the prior default while retrying), so it is truthy forever after the first
			// successful pass. Keyed off it, a post-boot rebuild that transiently sees zero certs (key
			// not yet synced, row missing mid-copy) would skip the retry and publish an empty
			// certificates list — the #1998 symptom, reintroduced on the live-rebuild path that a
			// long-running node is far more likely to hit than the boot race.
			this.timeout(15000);
			searchStub.restore(); // healthy baseline first — this describe stubs search empty by default
			const pseudoServer = { secureContexts: null, secureContextsListeners: [] };
			const selector = keys.createTLSSelector('mqtt', undefined, true);
			await selector.initialize(pseudoServer);
			assert.ok(pseudoServer.secureContexts.size > 0, 'baseline must be healthy before the transient outage');
			const publishedSizes = [];
			pseudoServer.secureContextsListeners.push(() => publishedSizes.push(pseudoServer.secureContexts.size));

			// Make the next pass transiently see zero certs, and trigger that pass through a real
			// cert-table write (the selector's live subscription).
			searchStub = sandbox.stub(databases.system.hdb_certificate, 'search').returns([]);
			const triggerCertName = 'transient-zero-trigger-' + Date.now();
			await databases.system.hdb_certificate.put({
				name: triggerCertName,
				certificate: test_cert,
				uses: [],
				is_authority: false,
				private_key_name: actual_cert.private_key_name,
				is_self_signed: true,
			});
			try {
				// The transient pass is observable via the warn latch it sets on the server object.
				await waitFor(() => pseudoServer.tlsSelectorWarnedZeroCerts === true, {
					timeout: 6000,
					message: 'the transient zero-cert rebuild never ran (or never took the retry path)',
				});

				searchStub.restore(); // certs are "back"; the pending retry must republish
				await waitFor(() => publishedSizes.length > 0, {
					timeout: 6000,
					message: 'the selector never republished after certificates became visible again',
				});
				assert.ok(
					publishedSizes.every((size) => size > 0),
					'a transient zero-cert rebuild must never publish an empty certificates list; published sizes: ' +
						publishedSizes.join(',')
				);
			} finally {
				await databases.system.hdb_certificate.delete(triggerCertName).catch(() => {});
			}
		});
	});

	describe('createTLSSelector when the hdb_certificate table object is swapped out', () => {
		// The mechanism behind the reported incident (#1998): the LMDB→RocksDB engine migration —
		// like resetDatabases() (copy_db, ITC restart) — REPLACES the databases.system.hdb_certificate
		// object rather than mutating it (the schemaMigrationFragility "F4" hazard), orphaning any
		// subscription bound to the old instance. The fix tracks the subscribed table instance inside
		// updateTLS and re-subscribes when it changes. This test drives that path end-to-end through
		// real module surfaces: the swap-detection can only run when something re-enters updateTLS,
		// and here that trigger is the selector's still-live subscription on the OLD table firing on
		// a write — the same trigger class (any scheduled rebuild) that a private-key reload or the
		// zero-certs retry supplies in production.
		let databases;
		let liveTLSRebuilders;
		let rebuildersSnapshot;
		let realTable;
		const swapTestCertName = 'swap-test-cert-' + Date.now();

		beforeEach(() => {
			databases = require('#src/resources/databases').databases;
			realTable = databases.system.hdb_certificate;
			liveTLSRebuilders = keys.__get__('liveTLSRebuilders');
			rebuildersSnapshot = [...liveTLSRebuilders];
		});

		afterEach(async () => {
			databases.system.hdb_certificate = realTable;
			await realTable.delete(swapTestCertName).catch(() => {});
			liveTLSRebuilders.clear();
			rebuildersSnapshot.forEach((r) => liveTLSRebuilders.add(r));
		});

		it('re-subscribes to the new table instance and rebuilds contexts on the next rebuild after a swap', async function () {
			this.timeout(10000);
			const pseudoServer = { secureContexts: null, secureContextsListeners: [] };
			const selector = keys.createTLSSelector('mqtt', undefined, true);
			await selector.initialize(pseudoServer);
			assert.ok(pseudoServer.secureContexts.size > 0, 'baseline must be healthy before the swap');
			const swapHostname = 'swap-test-unique.example.com';
			assert.strictEqual(pseudoServer.secureContexts.has(swapHostname), false, 'sentinel hostname must not pre-exist');

			// Model the engine-migration swap: a NEW table object (delegating to the real data so the
			// rebuild pass has certs to apply), while the selector's subscription still points at the
			// old instance. Live selectors left over from earlier tests in this file also detect the
			// swap and re-subscribe, so the counters below are cross-selector totals — the assertion
			// that THIS selector recovered is the sentinel hostname landing in its own contexts map.
			let subscribeCalls = 0;
			let searchCallsOnNewTable = 0;
			databases.system.hdb_certificate = {
				subscribe(options) {
					subscribeCalls++;
					return realTable.subscribe(options);
				},
				search(query) {
					searchCallsOnNewTable++;
					return realTable.search(query);
				},
			};

			// Trigger a rebuild through the old subscription (still attached to the real table): a
			// cert-table write, adding a record with a sentinel hostname that only a post-swap
			// rebuild (reading through the NEW table object) can surface into this selector's map.
			await realTable.put({
				name: swapTestCertName,
				certificate: test_cert,
				hostnames: [swapHostname],
				uses: [],
				is_authority: false,
				private_key_name: actual_cert.private_key_name,
				is_self_signed: true,
			});
			await waitFor(() => pseudoServer.secureContexts.has(swapHostname), {
				timeout: 6000,
				message:
					'this selector never rebuilt from the swapped-in table — the swap-detection/resubscribe path did not run',
			});
			// The rebuild that surfaced the sentinel runs the swap block first (liveReload=true and the
			// table object changed), so by now the selector must have re-subscribed through the new
			// instance and re-read through it.
			assert.ok(subscribeCalls >= 1, 'the rebuild must re-subscribe via the new table instance');
			assert.ok(searchCallsOnNewTable > 0, 'the rebuild must re-read certificates through the new table instance');
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

		// A chokidar watcher is chainable and its `on` returns the watcher.
		const fakeWatcher = (captureHandler) => {
			const watcher = {
				on: (event, handler) => {
					captureHandler?.(event, handler);
					return watcher;
				},
				close: () => Promise.resolve(),
			};
			return watcher;
		};

		beforeEach(() => {
			// Stub chokidar's watch so these tests exercise only the poll path and never open a real
			// FSWatcher (real watchers would leak fds and risk EMFILE across repeated runs).
			const chokidar = require('chokidar');
			localSandbox.stub(chokidar, 'watch').returns(fakeWatcher());
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
			localSandbox.stub(chokidar, 'watch').returns(
				fakeWatcher((event, handler) => {
					if (event === 'change') changeHandler = handler;
				})
			);

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

		it('reopens on polling when the watcher reports exhaustion', async () => {
			// chokidar emits 'error' unguarded for any code other than ENOENT/ENOTDIR, so without a
			// listener an ENOSPC here becomes an uncaughtException and the cert fast path dies silently.
			localSandbox.restore();
			const chokidar = require('chokidar');
			const openedOptions = [];
			const errorHandlers = [];
			const exhausted = () => Object.assign(new Error('inotify watch limit reached'), { code: 'ENOSPC' });
			localSandbox.stub(chokidar, 'watch').callsFake((_watchedPath, options) => {
				openedOptions.push(options);
				return fakeWatcher((event, handler) => {
					if (event === 'error') errorHandlers.push(handler);
				});
			});

			loadAndWatch(watchPath, () => {}, 'certificate');
			expect(openedOptions).to.have.lengthOf(1);
			expect(openedOptions[0].usePolling).to.equal(undefined);

			errorHandlers[0](exhausted());
			await new Promise((resolve) => setImmediate(resolve));

			expect(openedOptions).to.have.lengthOf(2);
			expect(openedOptions[1].usePolling).to.equal(true);

			// chokidar can emit several exhaustion errors before the failed watcher closes; none of them
			// may open a third.
			errorHandlers[0](exhausted());
			errorHandlers[1](exhausted());
			await new Promise((resolve) => setImmediate(resolve));
			expect(openedOptions).to.have.lengthOf(2);
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

		it('clamps a too-small configured interval up to the minimum, but 0 still disables', () => {
			const getCertificateWatchInterval = keys.__get__('getCertificateWatchInterval');
			const MIN = keys.__get__('MIN_CERTIFICATE_WATCH_INTERVAL_MS');
			const stub = localSandbox.stub(env_mgr, 'get');
			stub.callsFake(() => 1); // typo'd 1ms must not become a tight poll loop
			expect(getCertificateWatchInterval()).to.equal(MIN);
			stub.callsFake(() => 0); // 0 is the explicit "disable polling" sentinel
			expect(getCertificateWatchInterval()).to.equal(0);
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

	describe('resolveEffectiveTlsCiphers', () => {
		const resolve = keys.__get__('resolveEffectiveTlsCiphers');
		const RELAXED = 'DEFAULT@SECLEVEL=0';
		const layers = (config) => [{ source: 'tls', config }];

		it('returns undefined when nothing configures ciphers', () => {
			expect(resolve(layers({ certificate: 'x' }), [], 'server', false)).to.be.undefined;
			expect(resolve(undefined, undefined, 'server', true)).to.be.undefined;
		});

		it('applies a lone tls.ciphers as-is', () => {
			expect(resolve(layers({ ciphers: 'HIGH' }), [], 'server', false)).to.equal('HIGH');
		});

		it('composes a CA record SECLEVEL onto explicit tls.ciphers suites instead of replacing them', () => {
			const records = [{ name: 'ca', is_authority: true, ciphers: RELAXED }];
			expect(resolve(layers({ ciphers: 'HIGH' }), records, 'server', true)).to.equal('HIGH@SECLEVEL=0');
		});

		it('honors a tls array entry beyond [0] (previously silently ignored)', () => {
			expect(
				resolve(layers([{ certificate: 'a' }, { certificate: 'b', ciphers: RELAXED }]), [], 'server', false)
			).to.equal(RELAXED);
		});

		it('excludes a CA array entry when the listener does not verify client certificates', () => {
			expect(
				resolve(
					layers([{ certificate: 'a' }, { certificateAuthority: 'ca.pem', ciphers: RELAXED }]),
					[],
					'server',
					false
				)
			).to.be.undefined;
		});

		it('includes a CA array entry when the listener verifies client certificates', () => {
			expect(
				resolve(
					layers([{ certificate: 'a' }, { certificateAuthority: 'ca.pem', ciphers: RELAXED }]),
					[],
					'server',
					true
				)
			).to.equal(RELAXED);
		});

		it('applies a matching-use certificate record when config sets no ciphers', () => {
			const records = [{ name: 'cert', uses: ['server'], ciphers: RELAXED }];
			expect(resolve(layers({}), records, 'server', false)).to.equal(RELAXED);
		});

		it('applies generic (no uses) and legacy https records, mirroring selector relevance', () => {
			expect(resolve(layers({}), [{ name: 'generic', ciphers: RELAXED }], 'server', false)).to.equal(RELAXED);
			expect(resolve(layers({}), [{ name: 'legacy', uses: ['https'], ciphers: RELAXED }], 'server', false)).to.equal(
				RELAXED
			);
		});

		it("applies a 'server'-tagged legacy record only for the explicit LEGACY_SERVER_FALLBACK_TYPES allowlist (mqtt), not for any other listener type", () => {
			// 'server' was onSocket()'s raw-socket callers' usage type (and the plain-http default)
			// before per-caller usageType existed — a cert tagged uses: ['server'] must keep applying
			// to mqtt now that it passes its own specific type. This is an ALLOWLIST, not a denylist:
			// every other existing type (operations-api, replication, ...) has always had its own
			// dedicated identity and never defaulted to 'server', so none of them should newly start
			// accepting a ['server']-tagged record's ciphers/@SECLEVEL just because 'server' gained
			// legacy-generic status for mqtt's migration.
			const records = [{ name: 'legacy-server', uses: ['server'], ciphers: RELAXED }];
			expect(resolve(layers({}), records, 'mqtt', false)).to.equal(RELAXED);
			expect(resolve(layers({}), records, 'operations-api', false)).to.be.undefined;
			expect(resolve(layers({}), records, 'replication', false)).to.be.undefined;
		});

		it('normalizes a legacy scalar uses value', () => {
			const records = [{ name: 'cert', uses: 'server', ciphers: RELAXED }];
			expect(resolve(layers({}), records, 'server', false)).to.equal(RELAXED);
		});

		it('applies an authority record when the listener verifies client certificates', () => {
			// the incident shape: a client-CA record carrying SECLEVEL=0 for SHA-1-signed chains
			const records = [{ name: 'legacy-client-ca', is_authority: true, ciphers: RELAXED }];
			expect(resolve(layers({}), records, 'server', true)).to.equal(RELAXED);
		});

		it('ignores an authority record when the listener does not verify client certificates', () => {
			const records = [{ name: 'ca', is_authority: true, ciphers: RELAXED }];
			expect(resolve(layers({}), records, 'server', false)).to.be.undefined;
		});

		it('ignores records whose uses do not match the listener type', () => {
			const records = [{ name: 'ops-cert', uses: ['operations-api'], ciphers: RELAXED }];
			expect(resolve(layers({}), records, 'server', false)).to.be.undefined;
		});

		it('keeps the configured suite and applies the minimum explicit @SECLEVEL from a CA', () => {
			const records = [{ name: 'ca', is_authority: true, ciphers: RELAXED }];
			expect(resolve(layers([{ certificate: 'a', ciphers: 'DEFAULT' }]), records, 'server', true)).to.equal(
				'DEFAULT@SECLEVEL=0'
			);
			expect(resolve(layers([{ certificate: 'a', ciphers: 'HIGH:!aNULL' }]), records, 'server', true)).to.equal(
				'HIGH:!aNULL@SECLEVEL=0'
			);
		});

		it('does not assume a level for plain suites — an explicit @SECLEVEL always applies', () => {
			// the runtime default varies across Node/OpenSSL builds (2 on current Node), so 'HIGH'
			// carries no assumed level and the explicit SECLEVEL=1 must not lose a tie
			const records = [{ name: 'b', uses: ['server'], ciphers: 'DEFAULT@SECLEVEL=1' }];
			expect(resolve(layers([{ certificate: 'a', ciphers: 'HIGH' }]), records, 'server', false)).to.equal(
				'HIGH@SECLEVEL=1'
			);
		});

		it('prefers the operationsApi.tls layer over root tls for the operations listener', () => {
			const opsLayers = [
				{ source: 'operationsApi.tls', config: { ciphers: 'HIGH' } },
				{ source: 'tls', config: { ciphers: 'DEFAULT' } },
			];
			expect(resolve(opsLayers, [], 'operations-api', false)).to.equal('HIGH');
		});

		it('anchors a bare @SECLEVEL override to DEFAULT', () => {
			expect(resolve(layers({ ciphers: '@SECLEVEL=0' }), [], 'server', false)).to.equal('DEFAULT@SECLEVEL=0');
		});

		it('skips records without ciphers', () => {
			const records = [{ name: 'plain', uses: ['server'] }, null];
			expect(resolve(layers({}), records, 'server', false)).to.be.undefined;
		});
	});
});
