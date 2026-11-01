const assert = require('node:assert');
const { SocketAddress } = require('node:net');
const { formatPeerAddress, isLocalPeerAddress } = require('#src/server/serverHelpers/peerAddress');
const { UwsRequest } = require('#src/server/serverHelpers/Request');

const bytesOf = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));

// SocketAddress formats with libuv's uv_inet_ntop, the same function that produces socket.remoteAddress
function nodeText(bytes) {
	const groups = [];
	for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
	return new SocketAddress({ address: groups.join(':'), family: 'ipv6' }).address;
}

function withGroups(words) {
	const bytes = new Uint8Array(16);
	words.forEach((word, group) => {
		bytes[group * 2] = word >> 8;
		bytes[group * 2 + 1] = word & 0xff;
	});
	return bytes;
}

describe('formatPeerAddress', function () {
	it('writes IPv6 exactly as Node does for every arrangement of zero groups', function () {
		const values = [1, 0xffff, 0x10, 0x100, 0xabc, 0x7f00, 0x1234, 0xf00d];
		for (let mask = 0; mask < 256; mask++) {
			for (let rotation = 0; rotation < values.length; rotation++) {
				const words = [];
				for (let group = 0; group < 8; group++) {
					words.push(mask & (1 << group) ? values[(rotation + group) % values.length] : 0);
				}
				const bytes = withGroups(words);
				assert.strictEqual(formatPeerAddress(bytes), nodeText(bytes), Buffer.from(bytes).toString('hex'));
			}
		}
	});

	it('writes IPv6 exactly as Node does for random addresses', function () {
		let seed = 0x5eed;
		const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
		for (let i = 0; i < 20000; i++) {
			const words = [];
			for (let group = 0; group < 8; group++) {
				const roll = next();
				words.push(roll < 0.4 ? 0 : roll < 0.55 ? 0xffff : Math.floor(next() * 0x10000));
			}
			const bytes = withGroups(words);
			assert.strictEqual(formatPeerAddress(bytes), nodeText(bytes), Buffer.from(bytes).toString('hex'));
		}
	});

	const table = [
		['00000000000000000000000000000000', '::'],
		['00000000000000000000000000000001', '::1'],
		['00000000000000000000000000000002', '::2'],
		['00010000000000000000000000000000', '1::'],
		['00010000000000000000000000000002', '1::2'],
		['20010db8000000000000000000000001', '2001:db8::1'],
		['00010000000000010000000000010001', '1::1:0:0:1:1'], // equal runs: the first is compressed
		['00010000000000020000000000000003', '1:0:0:2::3'], // the longer run wins
		['00010000000200030004000500060007', '1:0:2:3:4:5:6:7'], // a single zero group stays
		['00000000000000000000ffff7f000001', '::ffff:127.0.0.1'],
		['00000000000000000000ffff00000001', '::ffff:0.0.0.1'],
		['0000000000000000000000000102030a', '::1.2.3.10'],
		['000000000000000000000000ffff0001', '::255.255.0.1'],
		['0000000000000000ffff000001020304', '::ffff:0:102:304'],
		['00000000000000000000ff007f000001', '::ff00:7f00:1'],
		['00000000000000000000000000ffffff', '::0.255.255.255'],
		['fe80000000000000021122fffe334455', 'fe80::211:22ff:fe33:4455'],
		['abcd0000000000010000000000000001', 'abcd:0:0:1::1'],
	];
	for (const [hex, text] of table) {
		it(`writes ${hex} as ${text}`, function () {
			assert.strictEqual(formatPeerAddress(bytesOf(hex)), text);
			assert.strictEqual(nodeText(bytesOf(hex)), text);
		});
	}

	it('writes 4 bytes as dotted IPv4', function () {
		assert.strictEqual(formatPeerAddress(Uint8Array.of(127, 0, 0, 1)), '127.0.0.1');
		assert.strictEqual(formatPeerAddress(Uint8Array.of(203, 0, 113, 255)), '203.0.113.255');
	});

	it('gives no address for any other length', function () {
		for (const length of [0, 3, 5, 15, 17]) assert.strictEqual(formatPeerAddress(new Uint8Array(length)), '');
	});

	it('returns strings that later calls do not change', function () {
		const long = formatPeerAddress(bytesOf('2001db8a12345678abcdef0123456789'));
		const short = formatPeerAddress(bytesOf('00000000000000000000000000000001'));
		const again = formatPeerAddress(bytesOf('20010db8000000000000000000000001'));
		assert.deepStrictEqual([long, short, again], ['2001:db8a:1234:5678:abcd:ef01:2345:6789', '::1', '2001:db8::1']);
	});
});

describe('isLocalPeerAddress', function () {
	for (const address of ['127.0.0.1', '127.0.0.200', '::ffff:127.0.0.1', '::ffff:127.0.0.9', '::1']) {
		it(`trusts ${address}`, function () {
			assert.strictEqual(isLocalPeerAddress(address), true);
		});
	}

	const untrusted = [
		'::127.0.0.1', // IPv4-compatible, not loopback
		'::ffff:7f00:1',
		'0000:0000:0000:0000:0000:0000:0000:0001',
		'2001:db8::1',
		'fe80::1',
		'::',
		'::2',
		'127.0.1.1',
		'10.127.0.0',
		'1127.0.0.1',
		'',
		undefined,
	];
	for (const address of untrusted) {
		it(`does not trust ${JSON.stringify(address)}`, function () {
			assert.strictEqual(isLocalPeerAddress(address), false);
		});
	}

	it('trusts the loopback peer bytes, and no other IPv6 peer, once formatted', function () {
		assert.strictEqual(isLocalPeerAddress(formatPeerAddress(bytesOf('00000000000000000000000000000001'))), true);
		assert.strictEqual(isLocalPeerAddress(formatPeerAddress(bytesOf('00000000000000000000ffff7f000001'))), true);
		assert.strictEqual(isLocalPeerAddress(formatPeerAddress(Uint8Array.of(127, 0, 0, 1))), true);
		for (const hex of [
			'0000000000000000000000007f000001', // ::127.0.0.1
			'20010db8000000000000000000000001',
			'fe800000000000000000000000000001',
			'00000000000000000000000000000002',
			'00000000000000000000ffff7f000101', // ::ffff:127.0.1.1
		]) {
			assert.strictEqual(isLocalPeerAddress(formatPeerAddress(bytesOf(hex))), false, hex);
		}
	});

	it('does not trust a non-loopback IPv6 uWS peer that sends a loopback X-Forwarded-For', function () {
		const request = new UwsRequest({
			method: 'GET',
			url: '/',
			headers: { 'x-forwarded-for': '127.0.0.1' },
			ip: formatPeerAddress(bytesOf('20010db8000000000000000000000001')),
		});
		assert.strictEqual(request.ip, '2001:db8::1');
		assert.strictEqual(isLocalPeerAddress(request.ip), false);
	});
});
