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

function isSelected(querySelect: string[], attr: string) {
	return (querySelect.length === 1 && querySelect[0] === '*') || querySelect.includes(attr);
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

async function asyncIterMap<T>(items: AsyncIterable<T>, mapFn: (item: T) => Promise<T>): Promise<T[]> {
	const promises: Promise<T>[] = [];
	for await (const item of items) {
		promises.push(mapFn(item));
	}
	return await Promise.all(promises);
}

export async function get(metric: string, getAttributes?: string[], startTime?: number, endTime?: number): Promise<Metric[]> {
	const conditions: Conditions = [{ attribute: 'metric', comparator: 'equals', value: metric }];
	const select = getAttributes ?? ['*'];

	// ensure we're always selecting id
	if (!isSelected(select, 'id')) {
		select.push('id');
	}

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

	return asyncIterMap(searchResults, async (result) => {
		// remove nodeId from 'id' attr and resolve it to the actual hostname and
		// add back in as 'node' attr if selected
		const nodeId = result.id[1];
		result['id'] = result['id'][0];
		if (isSelected(select, 'node')) {
			log.trace?.(`get_analytics lookup hostname for nodeId: ${nodeId}`);
			result['node'] = await lookupHostname(nodeId);
		}
		log.trace?.(`get_analytics result:`, JSON.stringify(result));
		return result;
	});
}
	}
}
