'use strict';

// Certificate verification caches into three replicated system tables. Every row carries its expiry as
// record metadata, and every node declares the tables with a table-level expiration, however its copy
// arrived, so reads hide an expired row and the cleanup scan removes it on every node. Starting shapes are
// made by the call their producer makes; shape assertions read the durable __dbis__ descriptors, which are
// what a restart loads.

const assert = require('node:assert');
const { createServer } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { webcrypto } = require('node:crypto');
const pkijs = require('pkijs');
const asn1js = require('asn1js');
const testUtils = require('../testUtils.js');
const { waitFor } = require('../waitFor.js');
const { databases, table, resetDatabases } = require('#src/resources/databases');
const { Resource } = require('#src/resources/Resource');
const bridge = require('#src/dataLayer/harperBridge/harperBridge').default;
const CreateTableObject = require('#src/dataLayer/CreateTableObject').default;
const manageThreads = require('#js/server/threads/manageThreads');
const { verifyCertificate } = require('#src/security/certificateVerification/index');
const { verifyOCSP } = require('#src/security/certificateVerification/ocspVerification');
const {
	bufferToPem,
	createCacheKey,
	createRevokedCertificateId,
	extractIssuerKeyId,
	extractSerialNumber,
} = require('#src/security/certificateVerification/verificationUtils');
const {
	CERTIFICATE_CACHE_TABLE,
	CRL_CACHE_TABLE,
	REVOKED_CERTIFICATES_TABLE,
	declareCertificateCacheTable,
	declareCRLCacheTable,
	declareRevokedCertificatesTable,
	ensureCertificateVerificationTables,
} = require('#src/security/certificateVerification/verificationTables');

const SECOND = 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const TABLES = {
	[CERTIFICATE_CACHE_TABLE]: {
		primaryKey: 'certificate_id',
		expiration: 3_600,
		indexedByAttribute: { status: false, reason: false, checked_at: false, method: false },
		declare: declareCertificateCacheTable,
	},
	[CRL_CACHE_TABLE]: {
		primaryKey: 'distribution_point',
		expiration: 86_400,
		indexedByAttribute: {
			issuer_dn: false,
			crl_blob: false,
			this_update: false,
			next_update: false,
			signature_valid: false,
		},
		declare: declareCRLCacheTable,
	},
	[REVOKED_CERTIFICATES_TABLE]: {
		primaryKey: 'composite_id',
		expiration: 691_200,
		indexedByAttribute: {
			serial_number: true,
			issuer_key_id: true,
			revocation_date: false,
			revocation_reason: false,
			crl_source: true,
			crl_next_update: false,
		},
		declare: declareRevokedCertificatesTable,
	},
};
const TABLE_NAMES = Object.keys(TABLES);

function systemTable(tableName) {
	return databases.system[tableName];
}

function storedExpiresAt(tableName, id) {
	return systemTable(tableName).primaryStore.getEntry(id)?.expiresAt;
}

function canonicalShape(tableName) {
	const { primaryKey, expiration, indexedByAttribute } = TABLES[tableName];
	return {
		schemaDefined: true,
		expiration,
		attributes: [
			{ name: primaryKey, type: undefined, isPrimaryKey: true },
			...Object.entries(indexedByAttribute).map(([name, indexed]) => ({
				name,
				type: undefined,
				expiresAt: false,
				indexed,
			})),
		].sort((a, b) => a.name.localeCompare(b.name)),
	};
}

function descriptors(tableName) {
	const rows = [];
	for (const { value } of systemTable(tableName).dbisDB.getRange({ start: tableName + '/', end: tableName + '0' }))
		if (value && !value.dropping) rows.push(value);
	return rows;
}

// The declared shape only; bookkeeping (format, generation, table id, audit) legitimately differs by history.
function declaredShape(attributes, primary) {
	return {
		schemaDefined: primary.schemaDefined,
		expiration: primary.expiration,
		attributes: attributes
			.map((attribute) =>
				attribute.isPrimaryKey
					? { name: attribute.name, type: attribute.type, isPrimaryKey: true }
					: {
							name: attribute.name,
							type: attribute.type,
							expiresAt: Boolean(attribute.expiresAt),
							indexed: Boolean(attribute.indexed),
						}
			)
			.sort((a, b) => a.name.localeCompare(b.name)),
	};
}

function assertCanonical(tableName) {
	const rows = descriptors(tableName);
	assert.deepStrictEqual(
		declaredShape(
			rows,
			rows.find((row) => row.isPrimaryKey)
		),
		canonicalShape(tableName),
		`${tableName} in __dbis__`
	);
	const Table = systemTable(tableName);
	assert.deepStrictEqual(
		declaredShape(Table.attributes, {
			schemaDefined: Table.schemaDefined,
			expiration: Table.expirationMS && Table.expirationMS / 1000,
		}),
		canonicalShape(tableName),
		`${tableName} as declared on this thread`
	);
	for (const name of Object.keys(TABLES[tableName].indexedByAttribute)) {
		const descriptor = Table.dbisDB.getSync(`${tableName}/${name}`);
		assert.strictEqual(descriptor.indexingFailed, undefined, `${tableName}.${name} indexing failed`);
		assert.strictEqual(descriptor.indexingPID, undefined, `${tableName}.${name} is still indexing`);
	}
}

async function dropTables() {
	for (const tableName of TABLE_NAMES) await systemTable(tableName)?.dropTable();
}

// The stub a fresh install (mount_hdb, from systemSchema.json) creates.
async function createAsSystemSchemaStub(tableName) {
	const { primaryKey } = TABLES[tableName];
	const createTable = new CreateTableObject('system', tableName, primaryKey);
	createTable.attributes = [{ attribute: primaryKey, isPrimaryKey: true }];
	createTable.audit = true;
	await bridge.createTable(tableName, createTable);
}

function preChangeDeclaration(tableName) {
	const { primaryKey, indexedByAttribute } = TABLES[tableName];
	return {
		table: tableName,
		database: 'system',
		attributes: [
			{ name: primaryKey, isPrimaryKey: true },
			...Object.entries(indexedByAttribute).map(([name, indexed]) => (indexed ? { name, indexed: true } : { name })),
			{ name: 'expiresAt', expiresAt: true, indexed: true },
		],
	};
}

// A replication handshake creating a table it lacks from a peer's DB_SCHEMA, which carries only
// { name, type, isPrimaryKey } per attribute (harper-pro ensureTableIfChanged -> ensureTable). The peer
// verified certificates before this change, so its schema lists expiresAt.
function createAsPeerHandshake(tableName, options = {}) {
	const { primaryKey } = TABLES[tableName];
	table({
		table: tableName,
		database: 'system',
		schemaDefined: options.schemaDefined ?? true,
		...options,
		attributes: preChangeDeclaration(tableName).attributes.map(({ name }) => ({
			name,
			type: undefined,
			isPrimaryKey: name === primaryKey || undefined,
		})),
	});
}

async function createAsPreChangeVerifyingNode(tableName) {
	await createAsSystemSchemaStub(tableName);
	table(preChangeDeclaration(tableName));
	await systemTable(tableName).indexingOperation;
}

function sampleRecord(tableName, id) {
	switch (tableName) {
		case CERTIFICATE_CACHE_TABLE:
			return { certificate_id: id, status: 'good', checked_at: Date.now(), method: 'ocsp' };
		case CRL_CACHE_TABLE:
			return {
				distribution_point: id,
				issuer_dn: 'CN=Test CA',
				crl_blob: Buffer.from('crl'),
				this_update: Date.now() - HOUR,
				next_update: Date.now() + DAY,
				signature_valid: true,
			};
		case REVOKED_CERTIFICATES_TABLE:
			return {
				composite_id: id,
				serial_number: '1000',
				issuer_key_id: 'issuer',
				revocation_date: Date.now() - DAY,
				revocation_reason: 'unspecified',
				crl_source: 'http://crl.example/ca.crl',
				crl_next_update: Date.now() + DAY,
			};
	}
}

// A row as replication applies it: the sender's stored expiry arrives as the write's metadata, and a
// sender that predates this change also wrote the field. A pre-change verdict was stored with no expiry.
function writeReplicatedRow(tableName, id, expiresAt) {
	const record = sampleRecord(tableName, id);
	if (expiresAt === undefined) return systemTable(tableName).put({ ...record, expiresAt: Date.now() + HOUR });
	return systemTable(tableName).put({ ...record, expiresAt }, { expiresAt });
}

// The pre-change verification path's direct put, whose expiry came from the field alone.
function writePreChangePut(tableName, id, expiresAt) {
	return systemTable(tableName).put({ ...sampleRecord(tableName, id), expiresAt });
}

// The pre-change certificate verdict fill: the source returned its expiry as a field, which a source fill
// does not store.
class PreChangeVerificationSource extends Resource {
	get(query) {
		return { ...sampleRecord(CERTIFICATE_CACHE_TABLE, query.id), expiresAt: Date.now() + HOUR };
	}
}

async function writePreChangeVerdict(id) {
	const Table = systemTable(CERTIFICATE_CACHE_TABLE);
	Table.sourcedFrom(PreChangeVerificationSource);
	await Table.get(id);
	// the fill commits after the get returns, and holds the record until it has
	await waitFor(
		() => {
			const entry = Table.primaryStore.getEntry(id);
			return entry?.value && !Table.primaryStore.hasLock(id, entry.version);
		},
		{ message: 'the verdict fill never committed' }
	);
}

// What a worker that never declares the table holds: a class built from the catalog alone.
function loadFromCatalog(tableName) {
	const Declared = systemTable(tableName);
	Declared.cleanup();
	delete databases.system[tableName];
	resetDatabases();
	assert.ok(systemTable(tableName) !== Declared, `${tableName} was rebuilt from the catalog`);
	return systemTable(tableName);
}

async function capturingCleanupScans(arm) {
	const originalSetTimeout = global.setTimeout;
	const scans = [];
	global.setTimeout = (callback, delay, ...args) => {
		if (new Error().stack.includes('scheduleCleanup')) scans.push(callback);
		return originalSetTimeout(callback, delay, ...args);
	};
	try {
		await arm();
	} finally {
		global.setTimeout = originalSetTimeout;
	}
	return scans;
}

const SIGNING = { name: 'ECDSA', namedCurve: 'P-256' };

function distinguishedName(commonName) {
	const names = new pkijs.RelativeDistinguishedNames();
	names.typesAndValues.push(
		new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: commonName }) })
	);
	return names;
}

async function createCertificate({ serialNumber, subject, issuer, publicKey, signingKey, isCA, crlUrl }) {
	const certificate = new pkijs.Certificate();
	certificate.version = 2;
	certificate.serialNumber = new asn1js.Integer({ value: serialNumber });
	certificate.subject = distinguishedName(subject);
	certificate.issuer = distinguishedName(issuer);
	certificate.notBefore.value = new Date(Date.now() - DAY);
	certificate.notAfter.value = new Date(Date.now() + 30 * DAY);
	await certificate.subjectPublicKeyInfo.importKey(publicKey);
	certificate.extensions = [
		new pkijs.Extension({
			extnID: '2.5.29.19',
			critical: true,
			extnValue: new pkijs.BasicConstraints({ cA: isCA }).toSchema().toBER(),
		}),
	];
	if (crlUrl) {
		const distributionPoints = new pkijs.CRLDistributionPoints({
			distributionPoints: [
				new pkijs.DistributionPoint({ distributionPoint: [new pkijs.GeneralName({ type: 6, value: crlUrl })] }),
			],
		});
		certificate.extensions.push(
			new pkijs.Extension({ extnID: '2.5.29.31', extnValue: distributionPoints.toSchema().toBER() })
		);
	}
	await certificate.sign(signingKey, 'SHA-256');
	return Buffer.from(certificate.toSchema(true).toBER());
}

async function createCRL({ issuer, signingKey, revokedSerials, thisUpdate, nextUpdate }) {
	const crl = new pkijs.CertificateRevocationList();
	crl.version = 1;
	crl.issuer = distinguishedName(issuer);
	crl.thisUpdate = new pkijs.Time({ type: 0, value: new Date(thisUpdate) });
	crl.nextUpdate = new pkijs.Time({ type: 0, value: new Date(nextUpdate) });
	crl.revokedCertificates = revokedSerials.map(
		(serial) =>
			new pkijs.RevokedCertificate({
				userCertificate: new asn1js.Integer({ value: serial }),
				revocationDate: new pkijs.Time({ type: 0, value: new Date(thisUpdate) }),
			})
	);
	await crl.sign(signingKey, 'SHA-256');
	return Buffer.from(crl.toSchema(true).toBER());
}

// A CRL states its times in whole seconds.
function wholeSecond(time) {
	return Math.floor(time / SECOND) * SECOND;
}

async function startCertificateAuthority() {
	let crlBody = null;
	let crlRequests = 0;
	let stallNext = false;
	const server = createServer((request, response) => {
		crlRequests++;
		if (!crlBody) {
			response.writeHead(503);
			return response.end();
		}
		response.writeHead(200, { 'Content-Type': 'application/pkix-crl', 'Content-Length': crlBody.length });
		if (stallNext) {
			stallNext = false;
			return response.write(crlBody.subarray(0, 16));
		}
		response.end(crlBody);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const crlUrl = `http://127.0.0.1:${server.address().port}/ca-${Date.now()}.crl`;
	const caKeys = await webcrypto.subtle.generateKey(SIGNING, true, ['sign', 'verify']);
	const caName = `Test CA ${crlUrl}`;
	const issuerDer = await createCertificate({
		serialNumber: 1,
		subject: caName,
		issuer: caName,
		publicKey: caKeys.publicKey,
		signingKey: caKeys.privateKey,
		isCA: true,
	});
	let nextSerial = 0x1000;
	return {
		crlUrl,
		issuerDer,
		async issue() {
			const keys = await webcrypto.subtle.generateKey(SIGNING, true, ['sign', 'verify']);
			const serialNumber = nextSerial++;
			const certDer = await createCertificate({
				serialNumber,
				subject: `client ${serialNumber}`,
				issuer: caName,
				publicKey: keys.publicKey,
				signingKey: caKeys.privateKey,
				isCA: false,
				crlUrl,
			});
			return { serialNumber, certDer };
		},
		async publish({ revokedSerials, thisUpdate, nextUpdate }) {
			crlBody = await createCRL({
				issuer: caName,
				signingKey: caKeys.privateKey,
				revokedSerials,
				thisUpdate: wholeSecond(thisUpdate),
				nextUpdate: wholeSecond(nextUpdate),
			});
		},
		unpublish() {
			crlBody = null;
		},
		stallNextResponse() {
			stallNext = true;
		},
		get crlRequests() {
			return crlRequests;
		},
		close: () =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	};
}

// A client certificate as the TLS layer hands it over, with its issuer in the presented chain.
function peerCertificate(authority, client) {
	return {
		raw: client.certDer,
		subject: { CN: `client ${client.serialNumber}` },
		issuerCertificate: { raw: authority.issuerDer },
	};
}

function crlOnlyVerification(failureMode, crl = {}) {
	return { certificateVerification: { failureMode, crl: { timeout: 5000, ...crl }, ocsp: { enabled: false } } };
}

function verdictKey(authority, client, method) {
	return createCacheKey(
		bufferToPem(client.certDer, 'CERTIFICATE'),
		bufferToPem(authority.issuerDer, 'CERTIFICATE'),
		method
	);
}

function revocationId(authority, client) {
	return createRevokedCertificateId(
		extractIssuerKeyId(bufferToPem(authority.issuerDer, 'CERTIFICATE')),
		extractSerialNumber(bufferToPem(client.certDer, 'CERTIFICATE'))
	);
}

describe('certificate verification tables', function () {
	this.timeout(60000);

	before(() => testUtils.ensureSystemTables());

	describe('every node declares the tables in one shape', () => {
		after(async () => {
			await dropTables();
			await ensureCertificateVerificationTables();
		});

		it('declares a fresh install’s primary-key stubs in full, keeping the expiry of each replicated row', async () => {
			await dropTables();
			for (const tableName of TABLE_NAMES) await createAsSystemSchemaStub(tableName);
			const liveUntil = Date.now() + HOUR;
			const laterUntil = Date.now() + 2 * HOUR;
			for (const tableName of TABLE_NAMES) {
				await writeReplicatedRow(tableName, 'in-window', liveUntil);
				await writeReplicatedRow(tableName, 'later', laterUntil);
			}
			await writeReplicatedRow(CERTIFICATE_CACHE_TABLE, 'pre-change-verdict', undefined);
			assert.strictEqual(storedExpiresAt(CERTIFICATE_CACHE_TABLE, 'pre-change-verdict'), undefined);

			await ensureCertificateVerificationTables();

			for (const tableName of TABLE_NAMES) {
				assertCanonical(tableName);
				assert.strictEqual(storedExpiresAt(tableName, 'in-window'), liveUntil, `${tableName} kept its expiry`);
				assert.strictEqual(storedExpiresAt(tableName, 'later'), laterUntil, `${tableName} kept its expiry`);
			}
			assert.strictEqual(
				systemTable(CERTIFICATE_CACHE_TABLE).primaryStore.getEntry('pre-change-verdict'),
				undefined,
				'a verdict stored with no expiry is evicted'
			);

			// a pre-change peer keeps replicating verdicts with no expiry until it upgrades
			const before = Date.now();
			await writeReplicatedRow(CERTIFICATE_CACHE_TABLE, 'late-pre-change-verdict', undefined);
			const fallback = storedExpiresAt(CERTIFICATE_CACHE_TABLE, 'late-pre-change-verdict');
			const expiration = TABLES[CERTIFICATE_CACHE_TABLE].expiration * 1000;
			assert.ok(fallback >= before + expiration && fallback <= Date.now() + expiration, `${fallback}`);
		});

		it('completes a copy that a replication handshake took from a pre-change peer', async () => {
			await dropTables();
			for (const tableName of TABLE_NAMES) createAsPeerHandshake(tableName);
			const liveUntil = Date.now() + HOUR;
			for (const tableName of TABLE_NAMES) await writeReplicatedRow(tableName, 'in-window', liveUntil);

			await ensureCertificateVerificationTables();

			for (const tableName of TABLE_NAMES) {
				assertCanonical(tableName);
				assert.strictEqual(storedExpiresAt(tableName, 'in-window'), liveUntil, `${tableName} kept its expiry`);
			}
		});

		it('makes a dynamic copy schema-defined', async () => {
			await dropTables();
			for (const tableName of TABLE_NAMES) createAsPeerHandshake(tableName, { schemaDefined: false });
			assert.strictEqual(systemTable(REVOKED_CERTIFICATES_TABLE).schemaDefined, false);

			await ensureCertificateVerificationTables();

			for (const tableName of TABLE_NAMES) assertCanonical(tableName);
		});

		it('repairs the tables of a node that verified certificates before this change, keeping each stored expiry', async () => {
			await dropTables();
			for (const tableName of TABLE_NAMES) await createAsPreChangeVerifyingNode(tableName);
			const liveUntil = Date.now() + HOUR;
			const laterUntil = Date.now() + 2 * HOUR;
			await writePreChangePut(CRL_CACHE_TABLE, 'in-window', liveUntil);
			await writePreChangePut(REVOKED_CERTIFICATES_TABLE, 'in-window', liveUntil);
			await writePreChangePut(REVOKED_CERTIFICATES_TABLE, 'later', laterUntil);
			await writePreChangeVerdict('pre-change-verdict');
			assert.strictEqual(storedExpiresAt(CERTIFICATE_CACHE_TABLE, 'pre-change-verdict'), undefined);

			await ensureCertificateVerificationTables();

			for (const tableName of TABLE_NAMES) assertCanonical(tableName);
			assert.strictEqual(storedExpiresAt(CRL_CACHE_TABLE, 'in-window'), liveUntil);
			assert.strictEqual(storedExpiresAt(REVOKED_CERTIFICATES_TABLE, 'in-window'), liveUntil);
			assert.strictEqual(storedExpiresAt(REVOKED_CERTIFICATES_TABLE, 'later'), laterUntil);
			assert.strictEqual(
				systemTable(CERTIFICATE_CACHE_TABLE).primaryStore.getEntry('pre-change-verdict'),
				undefined,
				'a verdict stored with no expiry is evicted'
			);
			// Only the declaring thread's class still holds a dropped index; the store stays on disk, unused.
			for (const tableName of TABLE_NAMES)
				assert.ok(!('expiresAt' in loadFromCatalog(tableName).indices), `${tableName} opens no expiresAt index`);
		});

		it('leaves tables already in the declared shape untouched', async () => {
			await dropTables();
			await ensureCertificateVerificationTables();
			const before = TABLE_NAMES.map((tableName) => descriptors(tableName));
			const builds = TABLE_NAMES.map((tableName) => systemTable(tableName).indexingOperation);

			await ensureCertificateVerificationTables();

			assert.deepStrictEqual(
				TABLE_NAMES.map((tableName) => descriptors(tableName)),
				before
			);
			TABLE_NAMES.forEach((tableName, index) =>
				assert.ok(systemTable(tableName).indexingOperation === builds[index], `${tableName} was not rebuilt`)
			);
		});

		it('the verification path declares the same tables', async () => {
			await ensureCertificateVerificationTables();
			for (const tableName of TABLE_NAMES) {
				assert.ok(TABLES[tableName].declare() === systemTable(tableName), `${tableName} is the same class`);
				assertCanonical(tableName);
			}
		});

		for (const tableName of TABLE_NAMES)
			it(`a node that only loads ${tableName} from its catalog removes the rows past their expiry`, async () => {
				await dropTables();
				await ensureCertificateVerificationTables();
				const spentAt = Date.now() - 60_000;
				const liveUntil = Date.now() + HOUR;
				await writeReplicatedRow(tableName, 'spent', spentAt);
				await writeReplicatedRow(tableName, 'in-window', liveUntil);

				// This thread stands in for the last worker, which owns the store's cleanup scan.
				const wasWorker = manageThreads.getWorkerIndex() === 0;
				manageThreads.setMainIsWorker(true);
				let scans;
				try {
					scans = await capturingCleanupScans(() => loadFromCatalog(tableName));
				} finally {
					manageThreads.setMainIsWorker(wasWorker);
				}
				assert.strictEqual(systemTable(tableName).expirationMS, TABLES[tableName].expiration * 1000);
				assert.strictEqual(scans.length, 1, 'loading the table arms its cleanup scan');

				await scans[0]();

				await waitFor(() => systemTable(tableName).primaryStore.getEntry('spent') === undefined, {
					timeout: 10000,
					message: 'the cleanup scan left the expired row in place',
				});
				assert.strictEqual(storedExpiresAt(tableName, 'in-window'), liveUntil);
			});
	});

	// After the shape tests: the verification modules memoize the tables they first see, which those tests drop.
	describe('verification writes each expiry as record metadata', () => {
		let authority;
		beforeEach(async () => {
			authority = await startCertificateAuthority();
		});
		afterEach(() => authority.close());

		it('an OCSP verdict expires cacheTtl after it is checked, and is checked again after that', async () => {
			const certDer = Buffer.from(`ocsp-cert-${Date.now()}`);
			const issuerDer = Buffer.from('ocsp-issuer');
			const config = { enabled: true, timeout: 1000, cacheTtl: SECOND, failureMode: 'fail-closed' };
			const id = createCacheKey(bufferToPem(certDer, 'CERTIFICATE'), bufferToPem(issuerDer, 'CERTIFICATE'), 'ocsp');
			const verdict = () => systemTable(CERTIFICATE_CACHE_TABLE).primaryStore.getEntry(id);
			const before = Date.now();

			// no responder answers, and an inconclusive verdict is cached like any other
			await verifyOCSP(certDer, issuerDer, config, ['http://127.0.0.1:9/ocsp']);

			const first = await waitFor(verdict, { message: 'the verdict was not cached' });
			assert.ok(first.expiresAt >= before + SECOND && first.expiresAt <= Date.now() + SECOND, `${first.expiresAt}`);
			assert.ok(!('expiresAt' in first.value), 'the expiry is record metadata, not a field');

			// models the verdict lapsing
			await waitFor(() => Date.now() > first.expiresAt, { interval: 50 });
			await verifyOCSP(certDer, issuerDer, config, ['http://127.0.0.1:9/ocsp']);

			await waitFor(() => verdict()?.value?.checked_at > first.value.checked_at, {
				message: 'the lapsed verdict was served instead of checked again',
			});
		});

		it('a verdict checked without a cacheTtl expires with the table expiration', async () => {
			const certDer = Buffer.from(`ocsp-cert-no-ttl-${Date.now()}`);
			const issuerDer = Buffer.from('ocsp-issuer');
			const before = Date.now();

			await verifyOCSP(certDer, issuerDer, { enabled: true, timeout: 1000, failureMode: 'fail-closed' }, [
				'http://127.0.0.1:9/ocsp',
			]);

			const id = createCacheKey(bufferToPem(certDer, 'CERTIFICATE'), bufferToPem(issuerDer, 'CERTIFICATE'), 'ocsp');
			const verdict = await waitFor(() => systemTable(CERTIFICATE_CACHE_TABLE).primaryStore.getEntry(id), {
				message: 'the verdict was not cached',
			});
			const expiration = TABLES[CERTIFICATE_CACHE_TABLE].expiration * 1000;
			assert.ok(
				verdict.expiresAt >= before + expiration && verdict.expiresAt <= Date.now() + expiration,
				`${verdict.expiresAt}`
			);
		});

		it('a CRL check stores the verdict and the revocations with their expiries', async () => {
			const client = await authority.issue();
			const nextUpdate = wholeSecond(Date.now() + DAY);
			await authority.publish({ revokedSerials: [client.serialNumber], thisUpdate: Date.now() - HOUR, nextUpdate });
			const cacheTtl = 600_000;
			const gracePeriod = 2 * HOUR;
			const before = Date.now();

			const result = await verifyCertificate(
				peerCertificate(authority, client),
				crlOnlyVerification('fail-closed', { cacheTtl, gracePeriod })
			);

			assert.strictEqual(result.status, 'revoked');
			const verdict = await waitFor(
				() => systemTable(CERTIFICATE_CACHE_TABLE).primaryStore.getEntry(verdictKey(authority, client, 'crl')),
				{ message: 'the verdict was not cached' }
			);
			assert.ok(verdict.expiresAt >= before + cacheTtl && verdict.expiresAt <= Date.now() + cacheTtl);
			assert.ok(!('expiresAt' in verdict.value), 'the verdict expiry is record metadata, not a field');

			const revocations = [];
			for (const entry of systemTable(REVOKED_CERTIFICATES_TABLE).primaryStore.getRange({ versions: true }))
				if (entry.value?.crl_source === authority.crlUrl) revocations.push(entry);
			assert.strictEqual(revocations.length, 1);
			assert.strictEqual(revocations[0].expiresAt, nextUpdate + gracePeriod);
			assert.strictEqual(revocations[0].value.crl_next_update, nextUpdate);
			assert.ok(!('expiresAt' in revocations[0].value), 'the revocation expiry is record metadata, not a field');
		});

		it('a certificate on a current CRL is revoked on its first check', async () => {
			const client = await authority.issue();
			await authority.publish({
				revokedSerials: [client.serialNumber],
				thisUpdate: Date.now() - HOUR,
				nextUpdate: Date.now() + DAY,
			});

			const result = await verifyCertificate(peerCertificate(authority, client), crlOnlyVerification('fail-closed'));

			assert.strictEqual(result.status, 'revoked');
			assert.strictEqual(result.valid, false);
		});

		it('a check decides by the CRL it downloaded, even once another thread has replaced the stored set', async () => {
			const client = await authority.issue();
			await authority.publish({
				revokedSerials: [client.serialNumber],
				thisUpdate: Date.now() - HOUR,
				nextUpdate: Date.now() + DAY,
			});
			const CrlCache = systemTable(CRL_CACHE_TABLE);
			const ownPut = Object.hasOwn(CrlCache, 'put');
			const put = CrlCache.put;
			// lands after this check stored its revocations: another thread's older CRL, without this one, commits
			CrlCache.put = async function (...args) {
				await systemTable(REVOKED_CERTIFICATES_TABLE).delete(revocationId(authority, client), {});
				return put.apply(this, args);
			};
			let result;
			try {
				result = await verifyCertificate(peerCertificate(authority, client), crlOnlyVerification('fail-closed'));
			} finally {
				if (ownPut) CrlCache.put = put;
				else delete CrlCache.put;
			}

			assert.strictEqual(result.status, 'revoked');
		});

		it('concurrent checks of certificates from one CA share one CRL download and replacement', async () => {
			const clients = [];
			for (let i = 0; i < 24; i++) clients.push(await authority.issue());
			const revoked = new Set(clients.filter((_, index) => index % 3 === 0).map((client) => client.serialNumber));
			await authority.publish({
				revokedSerials: [...revoked],
				thisUpdate: Date.now() - HOUR,
				nextUpdate: Date.now() + DAY,
			});

			const results = await Promise.all(
				clients.map((client) =>
					verifyCertificate(peerCertificate(authority, client), crlOnlyVerification('fail-closed'))
				)
			);

			assert.deepStrictEqual(
				results.map((result) => result.status),
				clients.map((client) => (revoked.has(client.serialNumber) ? 'revoked' : 'good'))
			);
			// every check that reached the download while one was in flight joined it
			assert.ok(
				authority.crlRequests < clients.length,
				`${authority.crlRequests} downloads for ${clients.length} checks`
			);
		});

		it('a CRL response that stalls after its headers fails its check at the timeout, and the next check downloads again', async () => {
			const stalled = await authority.issue();
			const client = await authority.issue();
			await authority.publish({
				revokedSerials: [client.serialNumber],
				thisUpdate: Date.now() - HOUR,
				nextUpdate: Date.now() + DAY,
			});
			authority.stallNextResponse();
			const config = crlOnlyVerification('fail-closed', { timeout: SECOND });

			const outcome = await Promise.race([
				verifyCertificate(peerCertificate(authority, stalled), config),
				delay(10 * SECOND, 'still waiting'),
			]);
			assert.notStrictEqual(outcome, 'still waiting', 'the check waited on the stalled body past its timeout');
			assert.strictEqual(outcome.valid, false);

			const result = await verifyCertificate(peerCertificate(authority, client), config);
			assert.strictEqual(result.status, 'revoked');
			assert.strictEqual(authority.crlRequests, 2);
		});

		for (const failureMode of ['fail-closed', 'fail-open'])
			it(`a certificate on a CRL past its nextUpdate but inside the grace period is revoked (${failureMode})`, async () => {
				const client = await authority.issue();
				await authority.publish({
					revokedSerials: [client.serialNumber],
					thisUpdate: Date.now() - 2 * DAY,
					nextUpdate: Date.now() - HOUR,
				});

				const result = await verifyCertificate(
					peerCertificate(authority, client),
					crlOnlyVerification(failureMode, { gracePeriod: DAY })
				);

				assert.strictEqual(result.status, 'revoked');
				assert.strictEqual(result.valid, false);
			});

		it('a revoked certificate stays revoked through the grace period while its CRL cannot be fetched (fail-open)', async () => {
			const client = await authority.issue();
			const nextUpdate = wholeSecond(Date.now()) + 3 * SECOND;
			await authority.publish({ revokedSerials: [client.serialNumber], thisUpdate: Date.now() - HOUR, nextUpdate });
			// the shortest verdict lifetime the configuration allows, so the next check reaches the CRL again
			const verification = crlOnlyVerification('fail-open', { cacheTtl: SECOND, gracePeriod: DAY });
			const peer = peerCertificate(authority, client);
			assert.strictEqual((await verifyCertificate(peer, verification)).status, 'revoked');
			const verdict = () =>
				systemTable(CERTIFICATE_CACHE_TABLE).primaryStore.getEntry(verdictKey(authority, client, 'crl'));
			const firstCheckedAt = (await waitFor(verdict, { message: 'the verdict was not cached' })).value.checked_at;

			authority.unpublish();
			// models the CRL lapsing: nextUpdate and the cached verdict both pass
			await waitFor(() => Date.now() > nextUpdate + SECOND, { timeout: 10_000, interval: 100 });

			const result = await verifyCertificate(peer, verification);
			assert.strictEqual(result.status, 'revoked');
			assert.strictEqual(result.valid, false);
			await waitFor(() => verdict()?.value?.checked_at > firstCheckedAt, {
				message: 'the lapsed verdict was served instead of checked again',
			});
		});

		const lapsedCRLs = { 'no grace period': [0, HOUR], 'a grace period that has passed': [DAY, 2 * DAY] };
		for (const [label, [gracePeriod, overdueBy]] of Object.entries(lapsedCRLs))
			it(`a CRL past its nextUpdate with ${label} establishes no verdict`, async () => {
				const client = await authority.issue();
				const nextUpdate = wholeSecond(Date.now() - overdueBy);
				await authority.publish({ revokedSerials: [client.serialNumber], thisUpdate: nextUpdate - DAY, nextUpdate });

				const result = await verifyCertificate(
					peerCertificate(authority, client),
					crlOnlyVerification('fail-closed', { gracePeriod })
				);

				assert.strictEqual(result.valid, false);
				assert.strictEqual(result.status, 'no-verification-available');
				assert.strictEqual(
					storedExpiresAt(REVOKED_CERTIFICATES_TABLE, revocationId(authority, client)),
					nextUpdate + gracePeriod
				);
			});

		it('a CRL that cannot be stored in full keeps the previous revocations and reads as no verdict', async () => {
			const [kept, failing] = [await authority.issue(), await authority.issue()];
			const firstNextUpdate = wholeSecond(Date.now()) + 3 * SECOND;
			await authority.publish({
				revokedSerials: [kept.serialNumber],
				thisUpdate: Date.now() - HOUR,
				nextUpdate: firstNextUpdate,
			});
			const verification = crlOnlyVerification('fail-closed', { cacheTtl: SECOND, gracePeriod: DAY });
			assert.strictEqual((await verifyCertificate(peerCertificate(authority, kept), verification)).status, 'revoked');
			await authority.publish({
				revokedSerials: [kept.serialNumber, failing.serialNumber],
				thisUpdate: Date.now(),
				nextUpdate: Date.now() + DAY,
			});
			// the next check refetches only once the first CRL has lapsed
			await waitFor(() => Date.now() > firstNextUpdate, { timeout: 10_000, interval: 100 });

			const Revoked = systemTable(REVOKED_CERTIFICATES_TABLE);
			const ownPut = Object.hasOwn(Revoked, 'put');
			const put = Revoked.put;
			const failingId = revocationId(authority, failing);
			Revoked.put = function (id, ...rest) {
				if (id === failingId) throw new Error('injected failure storing a revocation');
				return put.call(this, id, ...rest);
			};
			let result;
			try {
				result = await verifyCertificate(peerCertificate(authority, failing), verification);
			} finally {
				if (ownPut) Revoked.put = put;
				else delete Revoked.put;
			}

			assert.strictEqual(result.valid, false);
			assert.notStrictEqual(result.status, 'good');
			assert.strictEqual(
				storedExpiresAt(REVOKED_CERTIFICATES_TABLE, revocationId(authority, kept)),
				firstNextUpdate + DAY
			);
			assert.strictEqual(Revoked.primaryStore.getEntry(failingId), undefined);
		});
	});
});
