import { table, type Table } from '../databases.ts';
import crypto from 'crypto';
import { isIPv6 } from 'node:net';
import { Resource } from '../Resource.ts';

export const nodeIds = new Map<string, number>();

type AnalyticsHostnameResource = Resource & { hostname: string };

let AnalyticsHostnameTable: AnalyticsHostnameResource;
export function getAnalyticsHostnameTable() {
	if (!AnalyticsHostnameTable) {
		AnalyticsHostnameTable = table({
			table: 'hdb_analytics_hostname',
			database: 'system',
			attributes: [
				{
					name: 'id',
					isPrimaryKey: true,
				},
				{
					name: 'hostname',
				},
			],
		});
	}
	return AnalyticsHostnameTable;
}

const IPv4Pattern = /(\d{1,3}\.){3}\d{1,3}$/;

export function normalizeIPv6(ipv6: string) {
	// for embedded IPv4 in IPv6 e.g. ::ffff:127.0.0.1
	ipv6 = ipv6.replace(IPv4Pattern, (ipv4) => {
		const [a, b, c, d] = ipv4.split('.').map(n => parseInt(n));
		return ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
	});

	// shortened IPs e.g. 2001:db8::1428:57ab
	ipv6 = ipv6.replace('::', ':'.repeat(10 - ipv6.split(':').length));

	return ipv6
		.toLowerCase()
		.split(':')
		.map(v => v.padStart(4, '0'))
		.join(':');
}

function nodeHashToNumber(nodeHash: Uint8Array): number {
	if (nodeHash.length !== 4) {
		throw new Error(`nodeHash must be exactly 4 bytes (32 bits); got ${nodeHash.length} bytes`);
	}
	return (nodeHash[0] << 24) | (nodeHash[1] << 16) | (nodeHash[2] << 8) | nodeHash[3];
}

/** stableNodeId takes a hostname or IP address and returns a number containing
 * the 32-bit SHAKE128 hash of the hostname or IP address. The astute among you
 * will now be thinking, "Why return a 32-bit hash of a 32-bit IPv4 address?"
 * And the answer is that this is primarily intended for identifying cluster
 * nodes, and in production those should always use hostnames for TLS security.
 * So it doesn't make much sense to optimize the IPv4 use case.
 */
export function stableNodeId(nodeAddrOrName: string): number {
	const hasher = crypto.createHash('shake128', { outputLength: 4 }); // 4 bytes = 32 bits
	let normalized: string;
	if (isIPv6(nodeAddrOrName)) {
		normalized = normalizeIPv6(nodeAddrOrName);
	} else {
		normalized = nodeAddrOrName.toLowerCase();
	}
	return nodeHashToNumber(Uint8Array.from(hasher.update(normalized).digest()));
}

