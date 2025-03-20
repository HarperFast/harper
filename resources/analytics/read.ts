import type { SearchByConditionsRequest } from '../../dataLayer/harperBridge/ResourceBridge';
import search from '../../dataLayer/search';
import type { Metric } from './write';
import { loggerWithTag } from '../../utility/logging/harper_logger';
import { getAnalyticsHostnameTable } from './hostnames';

const log = loggerWithTag('analytics');

async function lookupHostname(nodeId: number): Promise<string|null> {
	const searchByIdReq = {
		database: 'system',
		table: getAnalyticsHostnameTable().name,
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
		searchByConditionsReq.conditions!.push({
			search_attribute: 'id',
			search_type: 'greater_than_equal',
			search_value: req.startTimestamp,
		});
	}
	if (req.endTimestamp) {
		searchByConditionsReq.conditions!.push({
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
		const nodeId: number = result.id[1];
		const hostname = await lookupHostname(nodeId);
		results.push({
			...result,
			node: hostname,
		});
	}
	return results;
}
