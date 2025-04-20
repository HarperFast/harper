import type { Metric } from './write.ts';
import { loggerWithTag } from '../../utility/logging/harper_logger.js';
import { getAnalyticsHostnameTable } from './hostnames.ts';
import type { Resource } from 'harperdb';
import type { Conditions } from '../ResourceInterface.ts';

const log = loggerWithTag('analytics');

type AnalyticsHostnameResource = Resource & { hostname: string };

async function lookupHostname(nodeId: number): Promise<string> {
	const result: AnalyticsHostnameResource = await getAnalyticsHostnameTable().get(nodeId);
	return result.hostname;
}

interface AnalyticsRequest {
	metric: string;
	startTimestamp?: number;
	endTimestamp?: number;
	getAttributes?: string[];
}

export async function get(req: AnalyticsRequest): Promise<Metric[]> {
	log.trace?.('get analytics request received');
	const conditions: Conditions = [{ attribute: 'metric', comparator: 'equals', value: req.metric }];
	const select = req.getAttributes ? req.getAttributes : ['*'];
	if (req.startTimestamp) {
		conditions.push({
			attribute: 'id',
			comparator: 'greater_than_equal',
			value: req.startTimestamp,
		});
	}
	if (req.endTimestamp) {
		conditions.push({
			attribute: 'id',
			comparator: 'less_than',
			value: req.endTimestamp,
		});
	}
	const request = { conditions, select };
	log.trace?.("get search request:", request);
	const searchResults = await databases.system.hdb_analytics.search(request);
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
