'use strict';

const assert = require('node:assert');
const { createHash } = require('node:crypto');
const dnsPromises = require('node:dns/promises');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const https = require('node:https');
const { tmpdir } = require('node:os');
const { syncBuiltinESMExports } = require('node:module');
const { join } = require('node:path');
const { inspect } = require('node:util');
const mkcert = require('mkcert');
const { SAFE_FETCH_TEST_TRANSPORT, isDeniedAddress, redactUrl, safeFetchToFile } = require('#src/utility/safeFetch');

const SECRET = 'X-Amz-Signature=sekrit-token-value';
const BODY = Buffer.from('harper-backup archive bytes '.repeat(4096));
const BODY_SHA = createHash('sha256').update(BODY).digest('hex');

describe('safeFetch', function () {
	this.timeout(20000);

	describe('isDeniedAddress', function () {
		const cases = [
			// [address, denied by default, denied with allowPrivateNetworks: false]
			['8.8.8.8', false, false],
			['93.184.216.34', false, false],
			['127.0.0.1', true, true],
			['127.255.0.9', true, true],
			['0.0.0.0', true, true],
			['169.254.0.1', true, true],
			['169.254.169.254', true, true],
			['224.0.0.1', true, true],
			['239.255.255.250', true, true],
			['255.255.255.255', true, true],
			['10.0.0.1', false, true],
			['172.16.5.4', false, true],
			['172.32.0.1', false, false],
			['192.168.1.1', false, true],
			['100.64.0.1', false, true],
			['2606:4700:4700::1111', false, false],
			['::', true, true],
			['::1', true, true],
			['0:0:0:0:0:0:0:1', true, true],
			['fe80::1', true, true],
			['fe80::1%en0', true, true],
			['febf::1', true, true],
			['ff02::1', true, true],
			['fd00:ec2::254', true, true],
			['fd12:3456::1', false, true],
			['fc00::1', false, true],
			['::ffff:127.0.0.1', true, true],
			['::ffff:7f00:1', true, true],
			['0:0:0:0:0:ffff:7f00:0001', true, true],
			['::ffff:169.254.169.254', true, true],
			['::ffff:a9fe:a9fe', true, true],
			['::ffff:0.0.0.0', true, true],
			['::127.0.0.1', true, true],
			['::7f00:1', true, true],
			['64:ff9b::127.0.0.1', true, true],
			['::ffff:8.8.8.8', false, false],
			['::ffff:10.0.0.1', false, true],
			['::ffff:192.168.0.1', false, true],
			['localhost', true, true],
			['not an address', true, true],
			['', true, true],
		];
		for (const [address, deniedByDefault, deniedStrict] of cases) {
			it(`${address || '(empty)'}: ${deniedByDefault ? 'denied' : 'allowed'} / strict ${deniedStrict ? 'denied' : 'allowed'}`, function () {
				assert.strictEqual(isDeniedAddress(address), deniedByDefault);
				assert.strictEqual(isDeniedAddress(address, { allowPrivateNetworks: true }), deniedByDefault);
				assert.strictEqual(isDeniedAddress(address, { allowPrivateNetworks: false }), deniedStrict);
			});
		}
	});

	describe('redactUrl', function () {
		it('keeps origin and path only', function () {
			assert.strictEqual(
				redactUrl(`https://user:pass@bucket.example.com:8443/backups/a.tar.gz?${SECRET}#frag`),
				'https://bucket.example.com:8443/backups/a.tar.gz'
			);
		});

		it('keeps no path or payload for non-http schemes', function () {
			assert.strictEqual(redactUrl('data:text/plain,sekrit'), 'data://');
			assert.strictEqual(redactUrl('not a url ?sekrit'), '<invalid URL>');
		});
	});

	describe('safeFetchToFile', function () {
		let server;
		let ca;
		let origin;
		let handler;
		let requests;
		let tempDir;
		let dest;

		before(async function () {
			const authority = await mkcert.createCA({
				organization: 'safeFetch test CA',
				countryCode: 'US',
				state: 'Colorado',
				locality: 'Denver',
				validity: 1,
			});
			const leaf = await mkcert.createCert({
				domains: ['127.0.0.1', 'localhost', 'archive.test'],
				validity: 1,
				ca: authority,
			});
			ca = authority.cert;
			server = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
				requests.push({ url: req.url, headers: req.headers });
				handler(req, res);
			});
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			origin = `https://127.0.0.1:${server.address().port}`;
		});

		after(async function () {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		});

		beforeEach(function () {
			requests = [];
			handler = serveBody();
			tempDir = mkdtempSync(join(tmpdir(), 'harper.unit-test.safe-fetch-'));
			dest = join(tempDir, 'archive');
		});

		afterEach(function () {
			rmSync(tempDir, { recursive: true, force: true });
		});

		function options(overrides = {}) {
			return {
				totalTimeoutMs: 10000,
				idleTimeoutMs: 5000,
				[SAFE_FETCH_TEST_TRANSPORT]: { trustedAddresses: ['127.0.0.1'], ca },
				...overrides,
			};
		}

		function url(path) {
			return `${origin}${path}?${SECRET}`;
		}

		function serveBody({ etag = '"v1"', lastModified, chunked = false, body = BODY } = {}) {
			return (req, res) => {
				const headers = {};
				if (etag) headers.etag = etag;
				if (lastModified) headers['last-modified'] = lastModified;
				if (!chunked) headers['content-length'] = body.length;
				res.writeHead(200, headers);
				res.end(body);
			};
		}

		// Sends the first `cut` bytes of a 200 response, then drops the connection.
		function breakAfter(cut, headers = { etag: '"v1"' }) {
			return (req, res) => {
				res.writeHead(200, { ...headers, 'content-length': BODY.length });
				res.write(BODY.subarray(0, cut), () => setTimeout(() => res.socket.destroy(), 20));
			};
		}

		function partial(from, total = BODY.length, contentRangeStart = from) {
			return (req, res) => {
				res.writeHead(206, {
					'etag': '"v1"',
					'content-range': `bytes ${contentRangeStart}-${total - 1}/${total}`,
					'content-length': BODY.length - from,
				});
				res.end(BODY.subarray(from));
			};
		}

		function sequence(...handlers) {
			let index = 0;
			return (req, res) => handlers[Math.min(index++, handlers.length - 1)](req, res);
		}

		async function assertFails(promise, statusCode, pattern) {
			const error = await promise.then(
				() => assert.fail('expected the fetch to fail'),
				(caught) => caught
			);
			assert.strictEqual(error.statusCode, statusCode, error.message);
			if (pattern) assert.match(error.message, pattern);
			assert.ok(!error.message.includes('sekrit'), `query leaked into the message: ${error.message}`);
			assert.ok(!inspect(error, { depth: 5 }).includes('sekrit'), 'query leaked into the error object');
			assert.ok(!existsSync(dest), 'partial file was left behind');
			return error;
		}

		it('downloads to the file and reports size, digest, identity and progress', async function () {
			let progress = 0;
			const result = await safeFetchToFile(url('/a.tar.gz'), dest, options({ onBytes: (n) => (progress += n) }));
			assert.deepStrictEqual(result, {
				bytes: BODY.length,
				sha256: BODY_SHA,
				redactedUrl: `${origin}/a.tar.gz`,
				etag: '"v1"',
			});
			assert.strictEqual(progress, BODY.length);
			assert.ok(readFileSync(dest).equals(BODY));
			assert.strictEqual(requests[0].url, `/a.tar.gz?${SECRET}`);
			assert.strictEqual(requests[0].headers['accept-encoding'], 'identity');
			assert.strictEqual(requests[0].headers.host, `127.0.0.1:${server.address().port}`);
			assert.strictEqual(requests[0].headers.authorization, undefined);
			assert.strictEqual(requests[0].headers.cookie, undefined);
		});

		it('connects to the address it validated, never re-resolving the host', async function () {
			const realLookup = dnsPromises.lookup;
			const lookups = [];
			dnsPromises.lookup = async (hostname, lookupOptions) => {
				lookups.push(hostname);
				if (hostname !== 'archive.test') return realLookup(hostname, lookupOptions);
				return lookups.length === 1
					? [{ address: '127.0.0.1', family: 4 }]
					: [{ address: '169.254.169.254', family: 4 }];
			};
			syncBuiltinESMExports();
			try {
				const port = server.address().port;
				const result = await safeFetchToFile(`https://archive.test:${port}/a?${SECRET}`, dest, options());
				assert.strictEqual(result.sha256, BODY_SHA);
				assert.strictEqual(result.redactedUrl, `https://archive.test:${port}/a`);
				assert.deepStrictEqual(lookups, ['archive.test']);
				assert.strictEqual(requests[0].headers.host, `archive.test:${port}`);
			} finally {
				dnsPromises.lookup = realLookup;
				syncBuiltinESMExports();
			}
		});

		it('refuses every scheme but https', async function () {
			for (const refused of [
				`http://127.0.0.1/a?${SECRET}`,
				`file:///etc/passwd?${SECRET}`,
				`data:text/plain,${SECRET}`,
				`ftp://example.com/a?${SECRET}`,
			]) {
				await assertFails(safeFetchToFile(refused, dest, options()), 400, /must use https:/);
			}
			assert.strictEqual(requests.length, 0);
		});

		it('refuses credentials in the userinfo', async function () {
			await assertFails(
				safeFetchToFile(`https://user:sekrit@127.0.0.1:1/a`, dest, options()),
				400,
				/must not carry credentials/
			);
		});

		it('refuses a loopback host without the test transport', async function () {
			await assertFails(
				safeFetchToFile(url('/a'), dest, { totalTimeoutMs: 5000, idleTimeoutMs: 5000 }),
				400,
				/denied address \(127\.0\.0\.1\)/
			);
			await assertFails(
				safeFetchToFile(`https://localhost:${server.address().port}/a?${SECRET}`, dest, options()),
				400,
				/denied address/
			);
			assert.strictEqual(requests.length, 0);
		});

		it('accepts a matching sha256 and rejects a mismatch, removing the file', async function () {
			const result = await safeFetchToFile(url('/a'), dest, options({ sha256: BODY_SHA.toUpperCase() }));
			assert.strictEqual(result.sha256, BODY_SHA);
			rmSync(dest);
			await assertFails(safeFetchToFile(url('/a'), dest, options({ sha256: '0'.repeat(64) })), 502, /sha256/);
		});

		it('refuses a body over maxBytes, declared or streamed', async function () {
			await assertFails(safeFetchToFile(url('/a'), dest, options({ maxBytes: BODY.length - 1 })), 413);
			handler = serveBody({ chunked: true });
			await assertFails(safeFetchToFile(url('/a'), dest, options({ maxBytes: BODY.length - 1 })), 413);
		});

		it('fails with 504 when the body stalls past the idle timeout', async function () {
			handler = (req, res) => {
				res.writeHead(200, { 'content-length': BODY.length });
				res.write(BODY.subarray(0, 100));
			};
			await assertFails(safeFetchToFile(url('/a'), dest, options({ idleTimeoutMs: 200 })), 504, /no data for 200 ms/);
		});

		it('fails with 504 at the total timeout even while bytes flow', async function () {
			handler = (req, res) => {
				res.writeHead(200, { 'content-length': BODY.length });
				const timer = setInterval(() => res.write('x'), 20);
				res.on('close', () => clearInterval(timer));
			};
			await assertFails(
				safeFetchToFile(url('/a'), dest, options({ idleTimeoutMs: 1000, totalTimeoutMs: 300 })),
				504,
				/within 300 ms/
			);
		});

		it('fails with 502 on a non-200 answer', async function () {
			handler = (req, res) => {
				res.writeHead(403);
				res.end('denied');
			};
			await assertFails(safeFetchToFile(url('/a'), dest, options()), 502, /HTTP 403/);
		});

		describe('redirects', function () {
			function redirectTo(location) {
				return (req, res) => {
					res.writeHead(302, { location });
					res.end();
				};
			}

			it('follows up to five redirects, re-requesting each hop', async function () {
				handler = (req, res) => {
					const hop = Number(new URL(req.url, origin).pathname.slice(1));
					if (hop < 5) redirectTo(`/${hop + 1}?${SECRET}`)(req, res);
					else serveBody()(req, res);
				};
				const result = await safeFetchToFile(url('/0'), dest, options());
				assert.strictEqual(result.sha256, BODY_SHA);
				assert.strictEqual(requests.length, 6);
			});

			it('refuses a sixth redirect', async function () {
				handler = (req, res) => {
					const hop = Number(new URL(req.url, origin).pathname.slice(1));
					redirectTo(`/${hop + 1}?${SECRET}`)(req, res);
				};
				await assertFails(safeFetchToFile(url('/0'), dest, options()), 400, /more than 5 redirects/);
				assert.strictEqual(requests.length, 6);
			});

			it('refuses a redirect to a denied address', async function () {
				for (const location of [
					`https://169.254.169.254/latest/meta-data?${SECRET}`,
					`https://[::ffff:127.0.0.2]:${server.address().port}/a?${SECRET}`,
					`https://[fd00:ec2::254]/a?${SECRET}`,
				]) {
					requests = [];
					handler = redirectTo(location);
					await assertFails(safeFetchToFile(url('/a'), dest, options()), 400, /denied address/);
					assert.strictEqual(requests.length, 1);
				}
			});

			it('refuses a redirect to a private address when private networks are disallowed', async function () {
				handler = redirectTo(`https://10.0.0.1/a?${SECRET}`);
				await assertFails(
					safeFetchToFile(url('/a'), dest, options({ allowPrivateNetworks: false })),
					400,
					/denied address \(10\.0\.0\.1\)/
				);
			});

			it('refuses a redirect to http', async function () {
				handler = redirectTo(`http://127.0.0.1:${server.address().port}/a?${SECRET}`);
				await assertFails(safeFetchToFile(url('/a'), dest, options()), 400, /refused a redirect: .*must use https:/);
				assert.strictEqual(requests.length, 1);
			});
		});

		describe('resume', function () {
			const cut = 30000;

			it('resumes with Range bound by If-Range and accepts a continuing 206', async function () {
				handler = sequence(breakAfter(cut), partial(cut));
				const result = await safeFetchToFile(url('/a'), dest, options());
				assert.strictEqual(result.sha256, BODY_SHA);
				assert.strictEqual(result.bytes, BODY.length);
				assert.ok(readFileSync(dest).equals(BODY));
				assert.strictEqual(requests.length, 2);
				assert.strictEqual(requests[1].headers.range, `bytes=${cut}-`);
				assert.strictEqual(requests[1].headers['if-range'], '"v1"');
			});

			it('binds the resume to Last-Modified when there is no strong ETag', async function () {
				const lastModified = 'Wed, 21 Oct 2026 07:28:00 GMT';
				handler = sequence(breakAfter(cut, { 'etag': 'W/"weak"', 'last-modified': lastModified }), partial(cut));
				const result = await safeFetchToFile(url('/a'), dest, options());
				assert.strictEqual(result.sha256, BODY_SHA);
				assert.strictEqual(requests[1].headers['if-range'], lastModified);
			});

			it('restarts from zero when the server answers the resume with 200', async function () {
				const changed = Buffer.from('a different object '.repeat(3000));
				handler = sequence(breakAfter(cut), serveBody({ etag: '"v2"', body: changed }));
				const result = await safeFetchToFile(url('/a'), dest, options());
				assert.strictEqual(result.bytes, changed.length);
				assert.strictEqual(result.sha256, createHash('sha256').update(changed).digest('hex'));
				assert.strictEqual(result.etag, '"v2"');
				assert.ok(readFileSync(dest).equals(changed));
				assert.strictEqual(requests[1].headers.range, `bytes=${cut}-`);
			});

			it('restarts from zero when the 206 Content-Range does not continue at the received length', async function () {
				handler = sequence(breakAfter(cut), partial(cut, BODY.length, cut - 10), serveBody());
				const result = await safeFetchToFile(url('/a'), dest, options());
				assert.strictEqual(result.sha256, BODY_SHA);
				assert.ok(readFileSync(dest).equals(BODY));
				assert.strictEqual(requests.length, 3);
				assert.strictEqual(requests[2].headers.range, undefined);
			});

			it('restarts from zero when the 206 total differs from the first response', async function () {
				handler = sequence(breakAfter(cut), partial(cut, BODY.length + 1), serveBody());
				const result = await safeFetchToFile(url('/a'), dest, options());
				assert.strictEqual(result.sha256, BODY_SHA);
				assert.strictEqual(requests.length, 3);
				assert.strictEqual(requests[2].headers.range, undefined);
			});

			it('restarts from zero without Range when the first response had no validator', async function () {
				handler = sequence(breakAfter(cut, {}), serveBody({ etag: undefined }));
				const result = await safeFetchToFile(url('/a'), dest, options());
				assert.strictEqual(result.sha256, BODY_SHA);
				assert.strictEqual(requests[1].headers.range, undefined);
				assert.strictEqual(requests[1].headers['if-range'], undefined);
			});

			it('gives up after a bounded number of resumes', async function () {
				handler = breakAfter(cut, {});
				await assertFails(safeFetchToFile(url('/a'), dest, options()), 502, /interrupted/);
				assert.strictEqual(requests.length, 6);
			});

			it('does not resume when resume is off', async function () {
				handler = sequence(breakAfter(cut), partial(cut));
				await assertFails(safeFetchToFile(url('/a'), dest, options({ resume: false })), 502, /interrupted after/);
				assert.strictEqual(requests.length, 1);
			});
		});
	});
});
