import type { SearchByConditionsRequest } from '../../dataLayer/harperBridge/ResourceBridge';
import search from '../../dataLayer/search';
import type { Metric } from './write';
import { loggerWithTag } from '../../utility/logging/harper_logger';
import { getAnalyticsHostnamesTable, nodeHashToNumber } from './hostnames';

const log = loggerWithTag('analytics');

async function lookupHostname(hostnameHash: Uint8Array): Promise<string|null> {
	const nodeId = nodeHashToNumber(hostnameHash);
	const searchByIdReq = {
		database: 'system',
		table: getAnalyticsHostnamesTable().name,
		ids: [nodeId],
		get_attributes: ['*'],
	};
	log.trace?.(`lookupHostname searchByIdReq: ${JSON.stringify(searchByIdReq)}`);
	const results = await search.searchByHash(searchByIdReq);
	for await (const result of results) {
		log.trace?.(`lookupHostname result: ${JSON.stringify(result)}`);
		return result.hostname;
	}
	return null; // OK to return null here b/c this is just a user convenience thing; should find a hostname eventually
}

function humanizeIPAddr(bytes: Uint8Array): string {
	switch (bytes.length) {
		case 4: // IPv4
			return bytes.join('.')
		case 16: // IPv6
			return bytes.join(':').replaceAll(/(:?0000:)+/g, '::'); // these should be host addresses so unlikely to end in :0000
		default:
			throw new Error(`IP address byte array should be either 4 bytes or 16 bytes long, but is ${bytes.length} bytes`);
	}
}

interface AnalyticsRequest {
	metric: string;
	startTimestamp?: number;
	endTimestamp?: number;
	getAttributes?: string[];
}

export async function get(req: AnalyticsRequest): Promise<Metric[]> {
	const searchByConditionsReq: SearchByConditionsRequest = {
		database: 'system',
		table: 'hdb_analytics',
		conditions: [{ search_attribute: 'metric', search_type: 'equals', search_value: req.metric }],
		get_attributes: req.getAttributes ? req.getAttributes : ['*'],
	};
	if (req.startTimestamp) {
		searchByConditionsReq.conditions.push({
			search_attribute: 'id',
			search_type: 'greater_than_equal',
			search_value: req.startTimestamp,
		});
	}
	if (req.endTimestamp) {
		searchByConditionsReq.conditions.push({
			search_attribute: 'id',
			search_type: 'less_than',
			search_value: req.endTimestamp,
		});
	}
	log.trace?.(`get searchByConditionsReq: ${JSON.stringify(searchByConditionsReq)}`);
	const searchResults = await search.searchByConditions(searchByConditionsReq);
	const results: Metric[] = [];
	for await (const result of searchResults) {
		log.trace?.(`get result: ${JSON.stringify(result)}`);
		switch (result.id[1]) {
			case 0:
				results.push({
					...result,
					node: humanizeIPAddr(result.id.slice(2)),
				});
				break;
			case 1: {
				let hostname: string;
				const hostHash: Uint8Array = result.id.slice(2);
				try {
					hostname = await lookupHostname(hostHash);
				} catch (err) {
					log.error?.('Error looking up hostname', err);
				}
				results.push({
					...result,
					node: hostname,
				});
				break;
			}
			default:
				throw new Error(`node identifier type should be 0 (IP address) or 1 (hostname) but is ${result.id[1]}`);
		}
	}
	return results;
}
