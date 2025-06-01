import type { Metric } from './write.ts';
import { forComponent } from '../../utility/logging/harper_logger.js';
import { getAnalyticsHostnameTable } from './hostnames.ts';
import type { Resource } from 'harperdb';
import type { Condition, Conditions } from '../ResourceInterface.ts';
import { METRIC, type BuiltInMetricName } from './metadata.ts';

const log = forComponent('analytics');

type AnalyticsHostnameResource = Resource & { hostname: string };

async function lookupHostname(nodeId: number): Promise<string> {
	const result: AnalyticsHostnameResource = await getAnalyticsHostnameTable().get(nodeId);
	return result.hostname;
}

function isSelected(querySelect: string[], attr: string) {
	return querySelect.length === 0 || querySelect.includes(attr);
}

interface GetAnalyticsRequest {
	metric: string;
	start_time?: number;
	end_time?: number;
	get_attributes?: string[];
	conditions?: Conditions;
}

type GetAnalyticsResponse = Metric[];

export function getOp(req: GetAnalyticsRequest): Promise<GetAnalyticsResponse> {
	log.trace?.('get_analytics request:', req);
	return get(req.metric, req.get_attributes, req.start_time, req.end_time, req.conditions);
}

export async function get(
	metric: string,
	getAttributes?: string[],
	startTime?: number,
	endTime?: number,
	additionalConditions?: Conditions
): Promise<Metric[]> {
	const conditions: Conditions = [{ attribute: 'metric', comparator: 'equals', value: metric }];
	if (additionalConditions) {
		conditions.push(...additionalConditions);
	}
	const select = getAttributes ?? [];

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

	const request = { conditions };
	if (select.length > 0) {
		request['select'] = select;
	}
	log.trace?.('get_analytics hdb_analytics.search request:', JSON.stringify(request));
	const searchResults = await databases.system.hdb_analytics.search(request);

	return searchResults.map(async (result: Metric) => {
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

type MetricType = 'builtin' | 'custom';

interface ListMetricsRequest {
	metric_types: MetricType[];
}

type ListMetricsResponse = string[];

export function listMetricsOp(req: ListMetricsRequest): Promise<ListMetricsResponse> {
	return listMetrics(req.metric_types);
}

export async function listMetrics(metricTypes: MetricType[] = ['builtin']): Promise<string[]> {
	let metrics: string[] = [];

	const builtins: BuiltInMetricName[] = Object.values(METRIC);

	if (metricTypes.includes('builtin')) {
		metrics = builtins;
	}

	if (metricTypes.includes('custom')) {
		const conditions = builtins.map((c) => {
			return {
				attribute: 'metric',
				comparator: 'not_equal',
				value: c,
			};
		});
		const customMetricsSearch = {
			select: ['metric'],
			conditions: conditions,
		};
		const customMetrics = new Set<string>();
		const searchResults = await databases.system.hdb_analytics.search(customMetricsSearch);
		for await (const record of searchResults) {
			customMetrics.add(record.metric);
		}

		metrics.push(...Array.from(customMetrics.values()));
	}

	return metrics;
}

interface DescribeMetricRequest {
	metric: string;
}

interface DescribeMetricResponse {
	attributes?: string[];
}

export function describeMetricOp(req: DescribeMetricRequest): Promise<DescribeMetricResponse> {
	return describeMetric(req.metric);
}

export async function describeMetric(metric: string): Promise<DescribeMetricResponse> {
	const lastEntrySearch = {
		conditions: [{ attribute: 'metric', comparator: 'equals', value: metric }],
		sort: {
			attribute: 'id',
			descending: true,
		},
		limit: 1,
	};
	const results = databases.system.hdb_analytics.search(lastEntrySearch);
	for await (const result of results) {
		return { attributes: Object.keys(result) };
	}
	return {};
}
