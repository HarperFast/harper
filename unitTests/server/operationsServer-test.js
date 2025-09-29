const { assert } = require('chai');
const { calculateRestHttpURL } = require('../../server/operationsServer.ts');

describe('Test operationsServer module', () => {
	describe(`Test calculateRestHttpURL`, function () {
		it('Chooses https when httpSecurePort provided', function () {
			const url = calculateRestHttpURL('80', '443', {
				hostname: '127.0.0.1',
				protocol: 'http',
			});
			assert.equal(url, 'https://127.0.0.1/');
		});

		it('Chooses can use non-standard ports', function () {
			const url = calculateRestHttpURL('80', '123', {
				hostname: '127.0.0.1',
				protocol: 'http',
			});
			assert.equal(url, 'https://127.0.0.1:123/');
		});

		it('Chooses http when httpSecurePort not provided', function () {
			const url = calculateRestHttpURL('80', undefined, {
				hostname: '127.0.0.1',
				protocol: 'http',
			});
			assert.equal(url, 'http://127.0.0.1/');
		});

		it('Uses configured port instead of the one from the request', function () {
			const url = calculateRestHttpURL('80', undefined, {
				hostname: '127.0.0.1:123',
				protocol: 'http',
			});
			assert.equal(url, 'http://127.0.0.1/');
		});

		it('Uses configured port instead of the one from the request', function () {
			const url = calculateRestHttpURL('80', undefined, {
				hostname: '127.0.0.1:123',
				protocol: 'http',
			});
			assert.equal(url, 'http://127.0.0.1/');
		});

		it('Uses port from the request if not otherwise configured', function () {
			const url = calculateRestHttpURL(undefined, undefined, {
				hostname: '127.0.0.1:123',
				protocol: 'http',
			});
			assert.equal(url, 'http://127.0.0.1:123/');
		});

		it('Uses the hostname from the request', function () {
			const url = calculateRestHttpURL('80', '443', {
				hostname: 'example.harper.com:123',
				protocol: 'https',
			});
			assert.equal(url, 'https://example.harper.com/');
		});

		it('Assume port forwarding and SSL termination with non-localhost, non-ips', function () {
			const url = calculateRestHttpURL(undefined, undefined, {
				hostname: 'example.harper.com',
				protocol: 'http',
			});
			assert.equal(url, 'https://example.harper.com/');
		});
	});
});
