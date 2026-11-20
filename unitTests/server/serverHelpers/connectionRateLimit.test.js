const assert = require('node:assert');
const sinon = require('sinon');
const harperLogger = require('#src/utility/logging/harper_logger');
const { createServer, connect } = require('node:net');
const tls = require('node:tls');
const { EventEmitter, once } = require('node:events');
const {
	createConnectionRateLimiter,
	gateConnectionEvents,
	gateListener,
} = require('#src/server/serverHelpers/connectionRateLimit');
const { sourceAddressKey, TokenBucket } = require('#src/server/serverHelpers/tokenBucket');
const { withProxyProtocol } = require('#src/server/serverHelpers/proxyProtocol');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

describe('connectionRateLimit', () => {
	let clock;
	const now = () => clock;
	beforeEach(() => {
		clock = 0;
	});

	describe('createConnectionRateLimiter', () => {
		it('is disabled without a positive perSecond', () => {
			assert.equal(createConnectionRateLimiter(undefined, 'test'), undefined);
			assert.equal(createConnectionRateLimiter({}, 'test'), undefined);
			assert.equal(createConnectionRateLimiter({ perSecond: 0, burst: 10 }, 'test'), undefined);
		});

		it('admits a burst from one address, then refills at perSecond', () => {
			const admit = createConnectionRateLimiter({ perSecond: 2, burst: 3 }, 'test', now);
			assert.deepEqual(
				[1, 2, 3, 4].map(() => admit('10.0.0.1')),
				[true, true, true, false]
			);
			clock = 499;
			assert.equal(admit('10.0.0.1'), false);
			clock = 500;
			assert.equal(admit('10.0.0.1'), true);
			assert.equal(admit('10.0.0.1'), false);
		});

		it('keeps a separate allowance per address', () => {
			const admit = createConnectionRateLimiter({ perSecond: 1, burst: 1 }, 'test', now);
			assert.equal(admit('10.0.0.1'), true);
			assert.equal(admit('10.0.0.1'), false);
			assert.equal(admit('10.0.0.2'), true);
		});

		it('defaults burst to perSecond, and never below one connection', () => {
			const admit = createConnectionRateLimiter({ perSecond: 2 }, 'test', now);
			assert.deepEqual(
				[1, 2, 3].map(() => admit('10.0.0.1')),
				[true, true, false]
			);
			const slow = createConnectionRateLimiter({ perSecond: 0.5 }, 'test', now);
			assert.deepEqual(
				[1, 2].map(() => slow('10.0.0.1')),
				[true, false]
			);
		});

		it('shares one allowance across an IPv6 /64 and between an IPv4 address and its mapped form', () => {
			const admit = createConnectionRateLimiter({ perSecond: 1, burst: 1 }, 'test', now);
			assert.equal(admit('2001:db8:1:2::1'), true);
			assert.equal(admit('2001:db8:1:2:ffff::9'), false);
			assert.equal(admit('2001:db8:1:3::1'), true);
			assert.equal(admit('::ffff:192.0.2.7'), true);
			assert.equal(admit('192.0.2.7'), false);
		});

		it('admits a connection with no address', () => {
			const admit = createConnectionRateLimiter({ perSecond: 1, burst: 1 }, 'test', now);
			assert.equal(admit(undefined), true);
			assert.equal(admit(''), true);
			assert.equal(admit(undefined), true);
		});

		it('admits a new address untracked once the tracked-address cap is reached, and says so', () => {
			const warn = sinon.stub(harperLogger, 'warn');
			try {
				const admit = createConnectionRateLimiter({ perSecond: 1, burst: 1 }, 'test', now);
				for (let i = 0; i < 100_000; i++) admit(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
				assert.equal(admit('192.0.2.1'), true);
				assert.equal(admit('192.0.2.1'), true);
				assert.equal(warn.callCount, 1);
				assert.match(warn.firstCall.args[0], /admitted 1 connection\(s\) from new addresses without a rate limit/);
				assert.equal(admit('10.0.0.0'), false);
			} finally {
				warn.restore();
			}
		});

		it('reports drops as one count per minute, never one line per drop', () => {
			const warn = sinon.stub(harperLogger, 'warn');
			try {
				const admit = createConnectionRateLimiter({ perSecond: 0.001, burst: 1 }, 'mqtt on port 1883', now);
				admit('10.0.0.1');
				for (let i = 0; i < 100; i++) admit('10.0.0.1');
				assert.equal(warn.callCount, 1);
				assert.match(warn.firstCall.args[0], /^mqtt on port 1883: dropped 1 connection/);
				clock = 59_999;
				admit('10.0.0.1');
				assert.equal(warn.callCount, 1);
				clock = 60_000;
				admit('10.0.0.1');
				assert.equal(warn.callCount, 2);
				assert.match(warn.secondCall.args[0], /dropped 101 connection/);
			} finally {
				warn.restore();
			}
		});

		it('prunes refilled addresses a step per accept, so new addresses are limited again after the cap', () => {
			const warn = sinon.stub(harperLogger, 'warn');
			try {
				const admit = createConnectionRateLimiter({ perSecond: 1, burst: 1 }, 'test', now);
				for (let i = 0; i < 100_000; i++) admit(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
				clock = 10_000;
				admit('192.0.2.1');
				// one step of the prune frees room, but nowhere near the whole map at once
				assert.equal(admit('192.0.2.2'), true);
				assert.equal(admit('192.0.2.2'), false);
				for (let i = 0; i < 2_000; i++) admit('192.0.2.3');
				for (let i = 0; i < 2_000; i++) assert.equal(admit(`192.0.${3 + (i >> 8)}.${i & 255}`), true);
				assert.equal(admit('192.0.3.0'), false);
			} finally {
				warn.restore();
			}
		});

		it('keeps an address still in debt across a prune', () => {
			const admit = createConnectionRateLimiter({ perSecond: 0.05, burst: 1 }, 'test', now);
			assert.equal(admit('10.0.0.1'), true);
			clock = 10_000;
			assert.equal(admit('10.0.0.2'), true);
			assert.equal(admit('10.0.0.1'), false);
		});
	});

	describe('gateConnectionEvents', () => {
		it('withholds an over-limit connection from every connection listener, including those added later', () => {
			const server = new EventEmitter();
			const seen = [];
			server.on('connection', (socket) => seen.push(['first', socket.remoteAddress]));
			const destroyed = [];
			gateConnectionEvents(server, (address) => address === 'admitted');
			server.on('connection', (socket) => seen.push(['later', socket.remoteAddress]));
			const socket = (remoteAddress) => ({ remoteAddress, on() {}, destroy: () => destroyed.push(remoteAddress) });
			assert.equal(server.emit('connection', socket('refused')), false);
			assert.equal(server.emit('connection', socket('admitted')), true);
			assert.deepEqual(seen, [
				['first', 'admitted'],
				['later', 'admitted'],
			]);
			assert.deepEqual(destroyed, ['refused']);
		});

		it('passes other events through untouched', () => {
			const server = new EventEmitter();
			let listening = 0;
			server.on('listening', () => listening++);
			gateConnectionEvents(server, () => false);
			server.emit('listening');
			assert.equal(listening, 1);
		});

		it('closes a refused TCP connection to a TLS server before its handshake starts', async () => {
			const server = tls.createServer({});
			let tlsErrors = 0;
			server.on('tlsClientError', () => tlsErrors++);
			gateConnectionEvents(server, () => false);
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			try {
				const client = connect(server.address().port, '127.0.0.1');
				client.on('error', () => {});
				// not a ClientHello, so a handshake that started would fail at once
				client.write('GET / HTTP/1.1\r\n\r\n');
				await new Promise((resolve) => client.on('close', resolve));
				assert.equal(tlsErrors, 0);
			} finally {
				server.close();
			}
		});

		it('resets a refused connection over a real TCP listener', async () => {
			let connections = 0;
			const server = createServer(() => connections++);
			gateConnectionEvents(server, () => false);
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			try {
				const client = connect(server.address().port, '127.0.0.1');
				// a FIN would end the stream cleanly; only an RST surfaces as ECONNRESET
				client.resume();
				const [error] = await once(client, 'error');
				assert.equal(error.code, 'ECONNRESET');
				assert.equal(connections, 0);
			} finally {
				server.close();
			}
		});
	});

	describe('gateListener', () => {
		it('destroys a refused socket instead of calling the listener', () => {
			const called = [];
			const destroyed = [];
			const listener = gateListener(
				(socket) => called.push(socket.remoteAddress),
				(address) => address === 'ok'
			);
			listener({ remoteAddress: 'ok', on() {}, destroy: () => destroyed.push('ok') });
			listener({ remoteAddress: 'no', on() {}, destroy: () => destroyed.push('no') });
			assert.deepEqual(called, ['ok']);
			assert.deepEqual(destroyed, ['no']);
		});

		it('keys a Unix socket connection on the address its PROXY header forwards', async function () {
			if (process.platform === 'win32') this.skip();
			const admit = createConnectionRateLimiter({ perSecond: 1, burst: 1 }, 'test', now);
			const admitted = [];
			const server = createServer(
				withProxyProtocol(gateListener((socket) => admitted.push(socket.remoteAddress), admit))
			);
			const directory = mkdtempSync(join(tmpdir(), 'conn-rate-'));
			const path = join(directory, 's.sock');
			server.listen(path);
			await once(server, 'listening');
			const connectFrom = (address) =>
				new Promise((resolve) => {
					const client = connect(path, () => client.write(`PROXY TCP4 ${address} 192.0.2.100 40000 1883\r\n`));
					client.on('error', () => {});
					client.on('close', resolve);
					setTimeout(() => client.destroy(), 200);
				});
			try {
				await connectFrom('192.0.2.1');
				await connectFrom('192.0.2.1');
				await connectFrom('192.0.2.2');
				assert.deepEqual(admitted, ['192.0.2.1', '192.0.2.2']);
			} finally {
				server.close();
				rmSync(directory, { recursive: true, force: true });
			}
		});
	});

	describe('tokenBucket', () => {
		it('reads its clock on every refill', () => {
			const bucket = new TokenBucket(1, 1, now);
			assert.equal(bucket.tryConsume(), true);
			assert.equal(bucket.hasToken(), false);
			clock = 1000;
			assert.equal(bucket.isFull(), true);
		});

		it('keys addresses by IPv4, mapped IPv4, and IPv6 /64', () => {
			assert.equal(sourceAddressKey('192.0.2.1'), '192.0.2.1');
			assert.equal(sourceAddressKey('192.0.2.1:5000'), '192.0.2.1');
			assert.equal(sourceAddressKey('::ffff:192.0.2.1'), '192.0.2.1');
			assert.equal(sourceAddressKey('2001:DB8:0:1::5'), '2001:db8:0:1::/64');
			assert.equal(sourceAddressKey('[2001:db8::1]:443'), '2001:db8:0:0::/64');
			assert.equal(sourceAddressKey('fe80::1%en0'), 'fe80:0:0:0::/64');
		});
	});
});
