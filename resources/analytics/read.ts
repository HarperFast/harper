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

interface GetAnalyticsRequest {
	metric: string;
	start_time?: number;
	end_time?: number;
	get_attributes?: string[];
}

type GetAnalyticsResponse = Metric[];

export function getOp(req: GetAnalyticsRequest): Promise<GetAnalyticsResponse> {
	log.trace?.("get_analytics request:", req);
	return get(req.metric, req.get_attributes, req.start_time, req.end_time);
}

export async function get(metric: string, getAttributes?: string[], startTime?: number, endTime?: number): Promise<Metric[]> {
	const conditions: Conditions = [{ attribute: 'metric', comparator: 'equals', value: metric }];
	const select = getAttributes ? getAttributes : ['*'];

	if (startTime) {
		conditions.push({
			attribute: 'id',
			comparator: 'greater_than_equal',
			value: startTime,
		});
	}
	if (endTime) {
		conditions.push({
			attribute: 'id',
			comparator: 'less_than',
			value: endTime,
		});
	}
	const request = { conditions, select };
	log.trace?.("get_analytics hdb_analytics.search request:", request);
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
