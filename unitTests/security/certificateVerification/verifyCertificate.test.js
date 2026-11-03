const assert = require('node:assert');
const { X509Certificate } = require('node:crypto');

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

// Same Ed25519 fixtures as trustedIssuers.test.js; the leaf carries an OCSP AIA for 127.0.0.1:18080.
const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBJTCB2KADAgECAgEBMAUGAytlcDAyMTAwFQYDVQQDDA5IYXJwZXIgVGVzdCBD
QTAXBgNVBAoMEEhhcnBlciBPQ1NQIFRlc3QwHhcNMjYwOTAxMjE0NzQ0WhcNMjcw
OTAxMjE0NzQ0WjAyMTAwFQYDVQQDDA5IYXJwZXIgVGVzdCBDQTAXBgNVBAoMEEhh
cnBlciBPQ1NQIFRlc3QwKjAFBgMrZXADIQA/ARiyM3Gz7K9HuO+LmHGxsCGvMszu
mxpDkr58EhthKqMTMBEwDwYDVR0TAQH/BAUwAwEB/zAFBgMrZXADQQCs/xR0lkdu
nO45pdieb8dsjRo/wcjx0O+xDAN4QtH7j4CpNQsyHvJzNJgODee9hVzH5LBufx0f
6im/vfIBngkJ
-----END CERTIFICATE-----`;
const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBajCCARygAwIBAgIBAzAFBgMrZXAwMjEwMBUGA1UEAwwOSGFycGVyIFRlc3Qg
Q0EwFwYDVQQKDBBIYXJwZXIgT0NTUCBUZXN0MB4XDTI2MDkwMTIxNDc0NFoXDTI3
MDkwMTIxNDc0NFowMDEuMBMGA1UEAwwMVmFsaWQgQ2xpZW50MBcGA1UECgwQSGFy
cGVyIE9DU1AgVGVzdDAqMAUGAytlcAMhAI9RNJ+274/TIvRG53cZb9g/Uj+WsQ7I
67J8vRkz83YHo1kwVzAMBgNVHRMBAf8EAjAAMDIGCCsGAQUFBwEBBCYwJDAiBggr
BgEFBQcwAYYWaHR0cDovLzEyNy4wLjAuMToxODA4MDATBgNVHSUEDDAKBggrBgEF
BQcDAjAFBgMrZXADQQDTP/KnPnD9wkVAkgzIid3d9uE8Mw1I+vmF389amqDUWDO7
qCv4tBFlJOXtP1Ky4nVswGNtB6aZTR0hRgFo8koJ
-----END CERTIFICATE-----`;

// Issued by the same CA but carrying no OCSP or CRL extension, so once its issuer is known the
// verdict is "no verification available" rather than a network fetch.
const NO_REVOCATION_URLS_LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIBNzCB6qADAgECAgECMAUGAytlcDAyMTAwFQYDVQQDDA5IYXJwZXIgVGVzdCBD
QTAXBgNVBAoMEEhhcnBlciBPQ1NQIFRlc3QwHhcNMjYwOTAxMjE0NzQ0WhcNMjcw
OTAxMjE0NzQ0WjAyMTAwFQYDVQQDDA5PQ1NQIFJlc3BvbmRlcjAXBgNVBAoMEEhh
cnBlciBPQ1NQIFRlc3QwKjAFBgMrZXADIQDr3XOcxKbo4x77G6sX9uYUEv/dwLx1
v8+KchJ6ldv8PaMlMCMwDAYDVR0TAQH/BAIwADATBgNVHSUEDDAKBggrBgEFBQcD
CTAFBgMrZXADQQAvVN+z7rC1aN2nW+YkMadPuy6IaLyqxJR6KJeOeD8Nrz7KIbB4
fh4DhcEhXJVXnVMUWEw0JMO1uzgsopaACEIK
-----END CERTIFICATE-----`;

const leaf = new X509Certificate(LEAF_PEM);
const noUrlsLeaf = new X509Certificate(NO_REVOCATION_URLS_LEAF_PEM);

/** getPeerCertificate(true)-shaped object for a socket that exposed only the leaf. */
function leafOnlyPeerCertificate(certificate = leaf) {
	return { subject: { CN: 'Valid Client' }, raw: certificate.raw, fingerprint256: certificate.fingerprint256 };
}

function mtlsConfig(certificateVerification) {
	return { user: 'admin', certificateVerification };
}

describe('certificateVerification/index.ts verifyCertificate() without an issuer in the socket chain', function () {
	let verifyCertificate;
	let trustedIssuers;

	before(function () {
		({ verifyCertificate } = require('#src/security/certificateVerification/index'));
		trustedIssuers = require('#src/security/certificateVerification/trustedIssuers');
	});

	afterEach(function () {
		trustedIssuers.publishTrustedAuthorities([]);
	});

	it('rejects under fail-closed when no trusted authority issued the leaf', async function () {
		const result = await verifyCertificate(leafOnlyPeerCertificate(), mtlsConfig({ failureMode: 'fail-closed' }));
		assert.deepStrictEqual(result, { valid: false, status: 'no-issuer-cert', method: 'disabled' });
	});

	it('rejects under the default failure mode (fail-closed)', async function () {
		const result = await verifyCertificate(leafOnlyPeerCertificate(), mtlsConfig(true));
		assert.strictEqual(result.valid, false);
		assert.strictEqual(result.status, 'no-issuer-cert');
	});

	it('allows under fail-open when no trusted authority issued the leaf', async function () {
		const result = await verifyCertificate(leafOnlyPeerCertificate(), mtlsConfig({ failureMode: 'fail-open' }));
		assert.deepStrictEqual(result, { valid: true, status: 'no-issuer-cert', method: 'disabled' });
	});

	it('reports disabled, not a rejection, when both CRL and OCSP are explicitly disabled', async function () {
		const result = await verifyCertificate(
			leafOnlyPeerCertificate(),
			mtlsConfig({ failureMode: 'fail-closed', crl: { enabled: false }, ocsp: { enabled: false } })
		);
		assert.deepStrictEqual(result, { valid: true, status: 'disabled', method: 'disabled' });
	});

	it('rejects a peer certificate object without certificate data under fail-closed', async function () {
		const result = await verifyCertificate({ subject: { CN: 'nobody' } }, mtlsConfig({ failureMode: 'fail-closed' }));
		assert.deepStrictEqual(result, { valid: false, status: 'no-issuer-cert', method: 'disabled' });
	});

	it('proceeds to the revocation check once the issuer is resolved from the trusted authorities', async function () {
		trustedIssuers.publishTrustedAuthorities([CA_PEM]);
		const result = await verifyCertificate(
			leafOnlyPeerCertificate(noUrlsLeaf),
			mtlsConfig({ failureMode: 'fail-closed' })
		);
		// the issuer gap was crossed: the verdict is about the (absent) revocation URLs, not the chain
		assert.deepStrictEqual(result, { valid: false, status: 'no-verification-available', method: 'disabled' });
	});

	it('uses the issuer the socket chain already carries even when no trusted authorities are published', async function () {
		const peerCertificate = leafOnlyPeerCertificate(noUrlsLeaf);
		peerCertificate.issuerCertificate = { raw: new X509Certificate(CA_PEM).raw };
		peerCertificate.issuerCertificate.issuerCertificate = peerCertificate.issuerCertificate;
		const result = await verifyCertificate(peerCertificate, mtlsConfig({ failureMode: 'fail-closed' }));
		assert.deepStrictEqual(result, { valid: false, status: 'no-verification-available', method: 'disabled' });
	});
});
