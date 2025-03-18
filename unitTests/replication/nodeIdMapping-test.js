require('../test_utils');
const chai = require('chai');
const expect = chai.expect;
const { stableNodeId, normalizeIPv6 } = require('../../server/replication/nodeIdMapping');

const MIN_32BIT_INT = Math.pow(-2, 31);
const MAX_32BIT_INT = Math.pow(2, 31) - 1;

describe('stableNodeId', () => {
	it('returns a 32-bit int for an IPv4 address', () => {
		const randOctet = () => Math.floor(Math.random() * 255);
		const randIPv4 = () => {
			const octets = [randOctet(), randOctet(), randOctet(), randOctet()];
			return octets.join('.');
		}
		for (let i = 0; i < 10000; i++) {
			const ipv4 = randIPv4();
			const id = stableNodeId(ipv4);
			expect(id).to.be.within(MIN_32BIT_INT, MAX_32BIT_INT);
		}
	});
	it('returns a 32-bit int for an IPv6 address', () => {
		const randIPv6Addr = () => {
			const hexDigits = '0123456789abcdef';
			let ipv6 = '';
			for (let i = 0; i < 8; i++) {
				for (let j = 0; j < 4; j++) {
					ipv6 += hexDigits.charAt(Math.floor(Math.random() * 16));
				}
				if (i < 7) {
					ipv6 += ':';
				}
			}
			return ipv6;
		};
		for (let i = 0; i < 10000; i++) {
			const ipv6 = randIPv6Addr();
			const id = stableNodeId(ipv6);
			expect(id).to.be.within(MIN_32BIT_INT, MAX_32BIT_INT);
		}
	});
	it('returns a 32-bit int for a hostname', () => {
		// just testing one hostname for now; this the default fallthrough in
		// much of the code so not sure how valuable the generative testing
		// approach is
		const hostname = "harper1.example.com";
		const id = stableNodeId(hostname);
		expect(id).to.be.within(MIN_32BIT_INT, MAX_32BIT_INT);
	});
});

describe('normalizeIPv6', () => {
	it('converts embedded IPv4 addresses to hex', () => {
		// eslint-disable-next-line sonarjs/no-hardcoded-ip
		const ipv6 = "::ffff:127.0.0.1";
		const normalized = normalizeIPv6(ipv6);
		// eslint-disable-next-line sonarjs/no-hardcoded-ip
		expect(normalized).to.equal("0000:0000:0000:0000:0000:ffff:7f00:0001");
	});
	it('converts :: to the needed number of 0000 segments', () => {
		const ipv6 = "::1";
		const normalized = normalizeIPv6(ipv6);
		// eslint-disable-next-line sonarjs/no-hardcoded-ip
		expect(normalized).to.equal("0000:0000:0000:0000:0000:0000:0000:0001");
	});
	it('left pads short segments with zeroes', () => {
		// eslint-disable-next-line sonarjs/no-hardcoded-ip
		const ipv6 = "2602:1:2:dead:beef:3:4:5";
		const normalized = normalizeIPv6(ipv6);
		// eslint-disable-next-line sonarjs/no-hardcoded-ip
		expect(normalized).to.equal("2602:0001:0002:dead:beef:0003:0004:0005");
	});
	it('lowercases hex letters A-F', () => {
		// eslint-disable-next-line sonarjs/no-hardcoded-ip
		const ipv6 = "2602:1:2:DEAD:BEEF:3:4:5";
		const normalized = normalizeIPv6(ipv6);
		// eslint-disable-next-line sonarjs/no-hardcoded-ip
		expect(normalized).to.equal("2602:0001:0002:dead:beef:0003:0004:0005");
	});
});
