'use strict';

const testUtils = require('../../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const {
	decodeProxyHeader,
	applyProxyHeader,
	applyDefaultPeerCertificate,
	synthesizePeerCertificate,
} = require('#src/server/serverHelpers/proxyProtocol');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Pre-baked test-only certs (100-year validity): a client cert signed by a CA,
// so chain synthesis has a real leaf→issuer relationship to reconstruct.
const CLIENT_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDFDCCAfygAwIBAgIJALgG+U05lYmQMA0GCSqGSIb3DQEBCwUAMDUxHjAcBgNV
BAMMFUhhcnBlciBUZXN0IENsaWVudCBDQTETMBEGA1UECgwKSGFycGVyVGVzdDAg
Fw0yNjA3MTgwMjQzNDBaGA8yMTI2MDYyNDAyNDM0MFowKzEUMBIGA1UEAwwLdGVz
dC1jbGllbnQxEzARBgNVBAoMCkhhcnBlclRlc3QwggEiMA0GCSqGSIb3DQEBAQUA
A4IBDwAwggEKAoIBAQDh/ml4nQ1INahgO/Bu10VP3p26p2R6XUrpHfTEGH6oR+5B
ka4OiFOtbqFr6j0Qpb8NqVVlcmycdQan2FO3AwAsHVPpJNo+9dE8tkHo9tK09SBK
DEUIsHeA/ZFwJ3PTp2qrr2NbzTdI0K9906IlFbI5Zaarmhq2JxNtBeqT3yX2jemV
Nge+cryUCHaKHTIFJfX21sRUT9oB9EKmFpHiSXTMeD6zvNcbzs1v0cG/FAGcw3pn
nGgTN6UGojtemajaNGIMqF7BPLdC3Exb08SFBoz/m3pNLw1LPxZiIndLwgopz9xW
2VgJKuUf03+pTAl892H8W/8/EK4rnfbQffosxV5dAgMBAAGjLzAtMAkGA1UdEwQC
MAAwCwYDVR0PBAQDAgWgMBMGA1UdJQQMMAoGCCsGAQUFBwMCMA0GCSqGSIb3DQEB
CwUAA4IBAQArp/g+KgRARDgZR1EbHqyLkhqKytyUEp4/bQbhjIhkUlpOhp/QXIdM
Z7DrWc6toXIPeu4fdI/HdCmTpWVIn6OmaLNCPMnaAB/gPgHC211WLhLlq/Jt/dat
C259VA1TJ18/LPdop8tcQ/RSdPmYdnaK/0SHbfNP/YcpF8QJ1t06AEQQjyHanMah
Kc/rR8IJW6jEgADimiMCrn42QjBSD8F6QPRTVkz2r8c5ZMbC0Br8C/v2ecbZAoP+
VISGVAhod3m5uABrxxAyzSKLCVlfIEw79tObe47308TnSIDkODi8X5Yaujr1561i
zn6KRjoqADdAWEoReJysyWWFkmIeiyy9
-----END CERTIFICATE-----`;

const CA_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIJAJWSH6HtLVvDMA0GCSqGSIb3DQEBCwUAMDUxHjAcBgNV
BAMMFUhhcnBlciBUZXN0IENsaWVudCBDQTETMBEGA1UECgwKSGFycGVyVGVzdDAg
Fw0yNjA3MTgwMjQzNDBaGA8yMTI2MDYyNDAyNDM0MFowNTEeMBwGA1UEAwwVSGFy
cGVyIFRlc3QgQ2xpZW50IENBMRMwEQYDVQQKDApIYXJwZXJUZXN0MIIBIjANBgkq
hkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4y4wMOukflN5rGh8zcNrFEt3/6NANzaW
GYtDVjT+ZHy+NDQfq0krzqYty5s6VtyC80TWtkhI8+WLPHvx+m2YqaOJOQyyhqjg
bJLLZPCfRaJjgR7DJDVv6EfUMcXwIg3Hy0V/O8UGqeJpn48msnB8agognXIyrOMA
ZprxkGVJlIcveTKQYMXFfn8N28GLhzTJt9nWqHYCPYp6hebf+hE/AM04W/5NJC+I
hXRY3I01EX4KJdAJ1PRwCex1G5t4D0qTDWqIicg+WsRo+AF28cClYEguY4ggJjge
OerXIFDlQOPUiFmLa0Q+ikf71ue6MeAJ9fJkj9AySEgwmnI9VbbpXQIDAQABoyAw
HjAPBgNVHRMBAf8EBTADAQH/MAsGA1UdDwQEAwIBBjANBgkqhkiG9w0BAQsFAAOC
AQEA00lObQ8FsON5I0vjoWOBxly9BGexj9oAty5vX2fu3j8feErfK6eaBSfxp2EV
/p9l9JGMKTSmBF+yGgtvILuNwaEg898MAls2fba3sL2EDm3vDh1HXug5igwr1yY7
nPt1Dt6//JLDf+vyUOsd2h3tdVZSRqHL3cWJFUyYRUByqc2LXRDoS70XRge2f4yk
hY2Za8FKb9gvArIZXwo53F97dcaKs5q2WfJ04fW1EodijTBVT370D+7V7OA0/1bM
ZyLmcxbrcUgdifXN1Rp0g8tHcsk0WF+NYkm4QrV+ICkyFCCxomLLoQceSOBL0joV
CMyAbIViTAqV3TM3i0Jh3caQ5A==
-----END CERTIFICATE-----`;

function pemToDer(pem) {
	return Buffer.from(pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ''), 'base64');
}
const CLIENT_DER = pemToDer(CLIENT_CERT_PEM);
const CA_DER = pemToDer(CA_CERT_PEM);

// ─── PROXY v2 header builder (what a fronting proxy like symphony emits) ──────

const PP2_SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);

function tlv(type, value) {
	const header = Buffer.alloc(3);
	header[0] = type;
	header.writeUInt16BE(value.length, 1);
	return Buffer.concat([header, value]);
}

function sslTlv({ certPresented = true, verify = 0 } = {}) {
	const value = Buffer.alloc(5);
	value[0] = 0x01 | (certPresented ? 0x02 : 0); // PP2_CLIENT_SSL | PP2_CLIENT_CERT_CONN
	value.writeUInt32BE(verify, 1);
	return tlv(0x20, value);
}

function buildV2Header({ family = 0x11, command = 0x01, srcIp = [1, 2, 3, 4], srcPort = 1111, tlvs = [] } = {}) {
	let addresses;
	if (family === 0x11) {
		addresses = Buffer.alloc(12);
		Buffer.from(srcIp).copy(addresses, 0);
		Buffer.from([127, 0, 0, 1]).copy(addresses, 4);
		addresses.writeUInt16BE(srcPort, 8);
	} else if (family === 0x21) {
		addresses = Buffer.alloc(36);
		Buffer.from(srcIp).copy(addresses, 0);
		addresses.writeUInt16BE(srcPort, 32);
	} else {
		addresses = Buffer.alloc(0);
	}
	const tlvBlock = Buffer.concat(tlvs);
	const header = Buffer.alloc(16);
	PP2_SIGNATURE.copy(header, 0);
	header[12] = 0x20 | command;
	header[13] = family;
	header.writeUInt16BE(addresses.length + tlvBlock.length, 14);
	return Buffer.concat([header, addresses, tlvBlock]);
}

// ─── decodeProxyHeader ────────────────────────────────────────────────────────

describe('proxyProtocol decodeProxyHeader', () => {
	it('decodes a v1 header', () => {
		const decision = decodeProxyHeader(Buffer.from('PROXY TCP4 1.2.3.4 5.6.7.8 1111 2222\r\nHELLO'));
		assert.strictEqual(decision.kind, 'header');
		assert.strictEqual(decision.srcIp, '1.2.3.4');
		assert.strictEqual(decision.srcPort, 1111);
		assert.strictEqual(decision.headerLength, 38);
	});

	it('returns incomplete for a partial v1 header and none past the spec max', () => {
		assert.strictEqual(decodeProxyHeader(Buffer.from('PRO')).kind, 'incomplete');
		assert.strictEqual(decodeProxyHeader(Buffer.from('PROXY TCP4 1.2.3.4')).kind, 'incomplete');
		assert.strictEqual(decodeProxyHeader(Buffer.from('PROXY ' + 'x'.repeat(200))).kind, 'none');
	});

	it('returns none for non-PROXY data', () => {
		assert.strictEqual(decodeProxyHeader(Buffer.from('MQTTCONNECT')).kind, 'none');
		assert.strictEqual(decodeProxyHeader(Buffer.from('GET / HTTP/1.1\r\n')).kind, 'none');
	});

	it('decodes a v2 TCP4 header with no TLVs', () => {
		const header = buildV2Header({ srcIp: [203, 0, 113, 9], srcPort: 45678 });
		const decision = decodeProxyHeader(Buffer.concat([header, Buffer.from('APP')]));
		assert.strictEqual(decision.kind, 'header');
		assert.strictEqual(decision.srcIp, '203.0.113.9');
		assert.strictEqual(decision.srcPort, 45678);
		assert.strictEqual(decision.headerLength, header.length);
		assert.strictEqual(decision.connectionInfo, undefined);
	});

	it('decodes a v2 TCP6 source address in compressed form', () => {
		const v6 = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
		const decision = decodeProxyHeader(buildV2Header({ family: 0x21, srcIp: v6, srcPort: 9000 }));
		assert.strictEqual(decision.kind, 'header');
		assert.strictEqual(decision.srcIp, '2001:db8::1');
		assert.strictEqual(decision.srcPort, 9000);
	});

	it('compresses the longest zero run and handles no-zero and all-zero addresses', () => {
		const decode = (bytes) => decodeProxyHeader(buildV2Header({ family: 0x21, srcIp: bytes, srcPort: 1 })).srcIp;
		// zero runs on both sides: longest wins
		assert.strictEqual(decode([0x20, 0x01, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2]), '2001:0:0:1::2');
		// loopback ::1
		assert.strictEqual(decode([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), '::1');
		// no zero groups
		assert.strictEqual(decode([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]), '1:2:3:4:5:6:7:8');
	});

	it('returns incomplete for partial v2 headers (signature, length, body)', () => {
		const header = buildV2Header({ tlvs: [sslTlv(), tlv(0xe2, CLIENT_DER)] });
		assert.strictEqual(decodeProxyHeader(header.subarray(0, 5)).kind, 'incomplete');
		assert.strictEqual(decodeProxyHeader(header.subarray(0, 15)).kind, 'incomplete');
		assert.strictEqual(decodeProxyHeader(header.subarray(0, header.length - 1)).kind, 'incomplete');
		assert.strictEqual(decodeProxyHeader(header).kind, 'header');
	});

	it('extracts the client cert chain from SSL + 0xE2 TLVs', () => {
		const header = buildV2Header({ tlvs: [sslTlv(), tlv(0xe2, CLIENT_DER), tlv(0xe2, CA_DER)] });
		const decision = decodeProxyHeader(header);
		assert.strictEqual(decision.kind, 'header');
		const info = decision.connectionInfo;
		assert.ok(info, 'connectionInfo expected');
		assert.strictEqual(info.tls.verified, true);
		assert.strictEqual(info.clientCertChain.length, 2);
		assert.ok(info.clientCertChain[0].equals(CLIENT_DER));
		assert.ok(info.clientCertChain[1].equals(CA_DER));
	});

	it('reports tls.verified=false when the SSL TLV verify field is nonzero', () => {
		const header = buildV2Header({ tlvs: [sslTlv({ verify: 1 }), tlv(0xe2, CLIENT_DER)] });
		const decision = decodeProxyHeader(header);
		assert.strictEqual(decision.connectionInfo.tls.verified, false);
	});

	it('ignores the cert chain when the SSL TLV does not report a presented cert', () => {
		const header = buildV2Header({ tlvs: [sslTlv({ certPresented: false }), tlv(0xe2, CLIENT_DER)] });
		const info = decodeProxyHeader(header).connectionInfo;
		// SSL TLV is still present (version/verify facts), but no cert chain is attached.
		assert.ok(info.tls, 'tls facts still present');
		assert.strictEqual(info.tls.verified, false);
		assert.strictEqual(info.clientCertChain, undefined);
	});

	it('captures ALPN, authority, JA3, JA4, and SSL version/cipher TLVs', () => {
		const sslWithSubTlvs = Buffer.concat([
			Buffer.from([0x01 | 0x02]), // client: SSL | CERT_CONN
			Buffer.from([0, 0, 0, 0]), // verify == 0
			tlv(0x21, Buffer.from('TLSv1.3')), // sub-TLV: version
			tlv(0x23, Buffer.from('TLS_AES_128_GCM_SHA256')), // sub-TLV: cipher
		]);
		const header = buildV2Header({
			tlvs: [
				tlv(0x01, Buffer.from('h2')),
				tlv(0x02, Buffer.from('api.example.com')),
				tlv(0x20, sslWithSubTlvs),
				tlv(0xe0, Buffer.from('0123456789abcdef0123456789abcdef')),
				tlv(0xe1, Buffer.from('t13d1516h2_8daaf6152771_02713d6af862')),
				tlv(0xe2, CLIENT_DER),
			],
		});
		const info = decodeProxyHeader(header).connectionInfo;
		assert.strictEqual(info.alpn, 'h2');
		assert.strictEqual(info.authority, 'api.example.com');
		assert.strictEqual(info.ja3, '0123456789abcdef0123456789abcdef');
		assert.strictEqual(info.ja4, 't13d1516h2_8daaf6152771_02713d6af862');
		assert.strictEqual(info.tls.version, 'TLSv1.3');
		assert.strictEqual(info.tls.cipher, 'TLS_AES_128_GCM_SHA256');
		assert.strictEqual(info.tls.verified, true);
		assert.ok(info.clientCertChain[0].equals(CLIENT_DER));
	});

	it('exposes JA3/JA4 without any SSL TLV or client cert', () => {
		const header = buildV2Header({
			tlvs: [
				tlv(0xe0, Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef')),
				tlv(0xe1, Buffer.from('t13i310900_e8f1e7e78f70_1c1d2d3e4f5a')),
			],
		});
		const info = decodeProxyHeader(header).connectionInfo;
		assert.strictEqual(info.ja3, 'deadbeefdeadbeefdeadbeefdeadbeef');
		assert.strictEqual(info.ja4, 't13i310900_e8f1e7e78f70_1c1d2d3e4f5a');
		assert.strictEqual(info.tls, undefined);
		assert.strictEqual(info.clientCertChain, undefined);
	});

	it('consumes a LOCAL command header without reading addresses', () => {
		const decision = decodeProxyHeader(buildV2Header({ command: 0x00, family: 0x00 }));
		assert.strictEqual(decision.kind, 'header');
		assert.strictEqual(decision.srcIp, undefined);
	});

	it('stops at a malformed TLV but keeps the parsed addresses', () => {
		// TLV declares 100 bytes of value but the header ends first
		const bogus = Buffer.from([0xe0, 0x00, 0x64]);
		const decision = decodeProxyHeader(buildV2Header({ srcIp: [9, 9, 9, 9], tlvs: [bogus] }));
		assert.strictEqual(decision.kind, 'header');
		assert.strictEqual(decision.srcIp, '9.9.9.9');
		assert.strictEqual(decision.connectionInfo, undefined);
	});
});

// ─── applyProxyHeader / applyDefaultPeerCertificate ───────────────────────────

describe('proxyProtocol applyProxyHeader', () => {
	it('overrides remoteAddress/remotePort and synthesizes the peer cert lazily', () => {
		const header = buildV2Header({ srcIp: [203, 0, 113, 9], srcPort: 443, tlvs: [sslTlv(), tlv(0xe2, CLIENT_DER)] });
		const socket = {};
		applyDefaultPeerCertificate(socket);
		assert.strictEqual(socket.authorized, false);
		assert.deepStrictEqual(socket.getPeerCertificate(), {});

		applyProxyHeader(socket, decodeProxyHeader(header));
		assert.strictEqual(socket.remoteAddress, '203.0.113.9');
		assert.strictEqual(socket.remotePort, 443);
		assert.strictEqual(socket.authorized, true);
		const cert = socket.getPeerCertificate(true);
		assert.strictEqual(cert.subject.CN, 'test-client');
		assert.strictEqual(socket.getPeerCertificate(true), cert, 'detailed certificate should be memoized');
		// Node semantics: without detailed=true the issuerCertificate chain is omitted
		const leaf = socket.getPeerCertificate();
		assert.strictEqual(leaf.subject.CN, 'test-client');
		assert.strictEqual(leaf.issuerCertificate, undefined);
		assert.strictEqual(socket.getPeerCertificate(), leaf, 'leaf certificate should be memoized');
	});

	it('leaves authorized=false when the proxy reported the cert as unverified', () => {
		const header = buildV2Header({ tlvs: [sslTlv({ verify: 2 }), tlv(0xe2, CLIENT_DER)] });
		const socket = {};
		applyDefaultPeerCertificate(socket);
		applyProxyHeader(socket, decodeProxyHeader(header));
		assert.strictEqual(socket.authorized, false);
		assert.strictEqual(socket.getPeerCertificate().subject.CN, 'test-client');
	});

	it('stashes connectionInfo on the socket for the request layer', () => {
		const sslWithSubTlvs = Buffer.concat([Buffer.from([0x01, 0, 0, 0, 0]), tlv(0x21, Buffer.from('TLSv1.3'))]);
		const header = buildV2Header({
			tlvs: [
				tlv(0x01, Buffer.from('h2')),
				tlv(0x02, Buffer.from('h.example.com')),
				tlv(0x20, sslWithSubTlvs),
				tlv(0xe1, Buffer.from('t13d1516h2_8daaf6152771_02713d6af862')),
			],
		});
		const socket = {};
		applyDefaultPeerCertificate(socket);
		applyProxyHeader(socket, decodeProxyHeader(header));
		assert.strictEqual(socket.connectionInfo.alpn, 'h2');
		assert.strictEqual(socket.connectionInfo.authority, 'h.example.com');
		assert.strictEqual(socket.connectionInfo.tls.version, 'TLSv1.3');
		assert.strictEqual(socket.connectionInfo.ja4, 't13d1516h2_8daaf6152771_02713d6af862');
		// No client cert in this header → the no-cert defaults stay in place.
		assert.strictEqual(socket.authorized, false);
		assert.deepStrictEqual(socket.getPeerCertificate(), {});
	});

	it('does not set connectionInfo for a v1 header', () => {
		const socket = {};
		applyDefaultPeerCertificate(socket);
		applyProxyHeader(socket, decodeProxyHeader(Buffer.from('PROXY TCP4 1.2.3.4 5.6.7.8 1111 2222\r\n')));
		assert.strictEqual(socket.remoteAddress, '1.2.3.4');
		assert.strictEqual(socket.connectionInfo, undefined);
	});
});

// ─── synthesizePeerCertificate ────────────────────────────────────────────────

describe('proxyProtocol synthesizePeerCertificate', () => {
	it('builds a Node-shaped certificate with issuerCertificate chain links', () => {
		const leaf = synthesizePeerCertificate([CLIENT_DER, CA_DER]);
		assert.strictEqual(leaf.subject.CN, 'test-client');
		assert.strictEqual(leaf.subject.O, 'HarperTest');
		assert.strictEqual(leaf.issuer.CN, 'Harper Test Client CA');
		assert.ok(leaf.raw.equals(CLIENT_DER));
		assert.match(leaf.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
		assert.ok(leaf.serialNumber.length > 0);
		assert.ok(leaf.valid_from && leaf.valid_to);

		const issuer = leaf.issuerCertificate;
		assert.strictEqual(issuer.subject.CN, 'Harper Test Client CA');
		assert.ok(issuer.raw.equals(CA_DER));
		// Self-signed terminal cert self-references, matching Node's getPeerCertificate(true)
		assert.strictEqual(issuer.issuerCertificate, issuer);
	});

	it('is consumable by certificateVerification.extractCertificateChain', () => {
		const { extractCertificateChain } = require('#src/security/certificateVerification/verificationUtils');
		const chain = extractCertificateChain(synthesizePeerCertificate([CLIENT_DER, CA_DER]));
		assert.strictEqual(chain.length, 2);
		assert.ok(chain[0].cert.equals(CLIENT_DER));
		assert.ok(chain[0].issuer.equals(CA_DER));
		assert.ok(chain[1].cert.equals(CA_DER));
	});

	it('self-references a single self-signed certificate', () => {
		const cert = synthesizePeerCertificate([CA_DER]);
		assert.strictEqual(cert.issuerCertificate, cert);
	});

	it('stops the chain at an unparseable certificate', () => {
		const leaf = synthesizePeerCertificate([CLIENT_DER, Buffer.from('garbage')]);
		assert.strictEqual(leaf.subject.CN, 'test-client');
		assert.strictEqual(leaf.issuerCertificate, undefined);
	});

	it('returns an empty object for an entirely unparseable chain', () => {
		assert.deepStrictEqual(synthesizePeerCertificate([Buffer.from('garbage')]), {});
	});
});

// ─── withProxyProtocol (pre-handoff wrapper for raw-protocol listeners) ───────
// Real sockets: MQTT-style handlers read socket.authorized/remoteAddress at
// connection time, so the identity must be applied BEFORE the listener runs.

describe('proxyProtocol withProxyProtocol', () => {
	const net = require('node:net');
	const { withProxyProtocol } = require('#src/server/serverHelpers/proxyProtocol');

	let server;
	let port;
	let connections;

	function listen(listener, prehandoffTimeout) {
		connections = [];
		server = net.createServer(withProxyProtocol(listener, prehandoffTimeout));
		return new Promise((resolve) => {
			server.listen(0, '127.0.0.1', () => {
				port = server.address().port;
				resolve();
			});
		});
	}

	afterEach((done) => {
		server.close(() => done());
	});

	// Listener that snapshots identity at invocation time, then echoes stream data.
	function snapshotListener(socket) {
		const snapshot = {
			authorized: socket.authorized,
			remoteAddress: socket.remoteAddress,
			remotePort: socket.remotePort,
			certCN: socket.getPeerCertificate(true)?.subject?.CN,
			data: [],
		};
		connections.push(snapshot);
		socket.on('data', (chunk) => {
			snapshot.data.push(chunk);
			socket.write(chunk);
		});
	}

	function roundTrip(payload, { split } = {}) {
		return new Promise((resolve, reject) => {
			const socket = net.connect(port, '127.0.0.1', () => {
				if (split) {
					socket.write(payload.subarray(0, split));
					setTimeout(() => socket.write(payload.subarray(split)), 20);
				} else {
					socket.write(payload);
				}
			});
			const chunks = [];
			socket.on('data', (chunk) => {
				chunks.push(chunk);
				socket.end();
			});
			socket.on('close', () => resolve(Buffer.concat(chunks)));
			socket.on('error', reject);
			setTimeout(() => reject(new Error('roundTrip timeout')), 3000);
		});
	}

	it('applies the forwarded mTLS identity before the listener runs', async () => {
		await listen(snapshotListener);
		const header = buildV2Header({
			srcIp: [203, 0, 113, 9],
			srcPort: 45678,
			tlvs: [sslTlv(), tlv(0xe2, CLIENT_DER)],
		});
		const echoed = await roundTrip(Buffer.concat([header, Buffer.from('MQTT-CONNECT')]));
		assert.strictEqual(echoed.toString(), 'MQTT-CONNECT');
		assert.strictEqual(connections.length, 1);
		// The listener saw the identity synchronously at connection time
		assert.strictEqual(connections[0].authorized, true);
		assert.strictEqual(connections[0].certCN, 'test-client');
		assert.strictEqual(connections[0].remoteAddress, '203.0.113.9');
		assert.strictEqual(connections[0].remotePort, 45678);
	});

	it('handles a header split across packets', async () => {
		await listen(snapshotListener);
		const header = buildV2Header({ srcIp: [9, 9, 9, 9], tlvs: [sslTlv(), tlv(0xe2, CLIENT_DER)] });
		const payload = Buffer.concat([header, Buffer.from('HELLO')]);
		const echoed = await roundTrip(payload, { split: 7 });
		assert.strictEqual(echoed.toString(), 'HELLO');
		assert.strictEqual(connections[0].authorized, true);
		assert.strictEqual(connections[0].remoteAddress, '9.9.9.9');
	});

	it('hands off non-PROXY connections with no-client-cert defaults', async () => {
		await listen(snapshotListener);
		const echoed = await roundTrip(Buffer.from('MQTTCONNECT'));
		assert.strictEqual(echoed.toString(), 'MQTTCONNECT');
		assert.strictEqual(connections[0].authorized, false);
		assert.strictEqual(connections[0].certCN, undefined);
	});

	it('destroys a connection that stalls before completing the header', async () => {
		await listen(snapshotListener, 100);
		const header = buildV2Header({});
		await new Promise((resolve, reject) => {
			const socket = net.connect(port, '127.0.0.1', () => socket.write(header.subarray(0, 7)));
			socket.on('error', () => {});
			const timer = setTimeout(() => reject(new Error('stalled connection was not destroyed')), 2000);
			socket.on('close', () => {
				clearTimeout(timer);
				resolve();
			});
		});
		assert.strictEqual(connections.length, 0, 'listener must not run for an incomplete header');
	});
});
