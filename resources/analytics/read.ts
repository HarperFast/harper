import type { Metric } from './write.ts';
import harperLogger from '../../utility/logging/harper_logger.js';
const { forComponent } = harperLogger;
import { getAnalyticsHostnameTable } from './hostnames.ts';
import type { Condition, Conditions } from '../ResourceInterface.ts';
import { METRIC, type BuiltInMetricName } from './metadata.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import { get as envGet } from '../../utility/environment/environmentManager.js';

// default to one week time window for finding custom metrics
const defaultCustomMetricWindow = 1000 * 60 * 60 * 24 * 7;

const log = forComponent('analytics').conditional;

async function lookupHostname(nodeId: number): Promise<string> {
	const result = await getAnalyticsHostnameTable().get(nodeId);
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
	coalesce_time?: boolean;
	conditions?: Conditions;
}

type GetAnalyticsResponse = Metric[];

export function getOp(req: GetAnalyticsRequest): Promise<GetAnalyticsResponse> {
	log.trace?.('get_analytics request:', req);
	return get(req.metric, {
		getAttributes: req.get_attributes,
		startTime: req.start_time,
		endTime: req.end_time,
		coalesceTime: req.coalesce_time,
		additionalConditions: req.conditions,
	});
}

function conformCondition(condition: Condition): Condition {
	if ('conditions' in condition) {
		return {
			...condition,
			conditions: condition.conditions.map(conformCondition),
		};
	}
	return {
		attribute: condition.search_attribute ?? condition.attribute,
		comparator: condition.search_type ?? condition.comparator,
		value: condition.search_value ?? condition.value,
	};
}

async function coalesceResults(results: Metric[], window: number): Promise<Metric[]> {
	const coalescedResults: Metric[] = [];
	let coalesceId;
	let lastCoalescedId = new Map<string, number>();
	for await (const result of results) {
		const id = result.id;
		if (!coalesceId) {
			coalesceId = id;
		}
		const delta = Math.abs(id - coalesceId);
		if (delta < window && lastCoalescedId.get(result.node) !== id) {
			coalescedResults.push({ ...result, id: coalesceId });
			lastCoalescedId.set(result.node, id);
		} else if (lastCoalescedId.get(result.node) !== id) {
			coalescedResults.push(result);
			coalesceId = id;
		}
	}
	return coalescedResults;
}

interface GetAnalyticsOpts {
	getAttributes?: string[];
	startTime?: number;
	endTime?: number;
	coalesceTime?: boolean;
	additionalConditions?: Conditions;
}

export async function get(metric: string, opts?: GetAnalyticsOpts): Promise<Metric[]> {
	const { getAttributes, startTime, endTime, additionalConditions } = opts ?? {};
	const conditions: Conditions = [{ attribute: 'metric', comparator: 'equals', value: metric }];
	if (additionalConditions) {
		conditions.push(...additionalConditions.map(conformCondition));
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

	const request = { conditions, allowConditionsOnDynamicAttributes: true };
	if (select.length > 0) {
		request['select'] = select;
	}
	log.trace?.('get_analytics hdb_analytics.search request:', JSON.stringify(request));
	const searchResults = await databases.system.hdb_analytics.search(request);

	let results = searchResults.map(async (result: Metric) => {
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

	if (opts?.coalesceTime) {
		// coalescing window is the aggregate period plus 10% & converted to milliseconds
		const window = envGet(CONFIG_PARAMS.ANALYTICS_AGGREGATEPERIOD) * 1.1 * 1000;
		results = await coalesceResults(results, window);
	}

	return results;
}

type MetricType = 'builtin' | 'custom';

interface ListMetricsRequest {
	metric_types: MetricType[];
	custom_metrics_window?: number;
}

type ListMetricsResponse = string[];

export function listMetricsOp(req: ListMetricsRequest): Promise<ListMetricsResponse> {
	return listMetrics(req.metric_types, req.custom_metrics_window);
}

export async function listMetrics(
	metricTypes: MetricType[] = ['builtin'],
	customWindow: number = defaultCustomMetricWindow
): Promise<string[]> {
	let metrics: string[] = [];

	const builtins: BuiltInMetricName[] = Object.values(METRIC);

	if (metricTypes.includes('builtin')) {
		metrics = builtins;
	}

	if (metricTypes.includes('custom')) {
		const oldestCustomId = Date.now() - customWindow;
		const conditions: Conditions = [
			{
				attribute: 'id',
				comparator: 'greater_than',
				value: oldestCustomId,
			},
		];
		const metricConditions = builtins.map((c) => {
			return {
				attribute: 'metric',
				comparator: 'not_equal',
				value: c,
			} as Condition;
		});
		conditions.push(...metricConditions);
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

interface MetricDescription {
	name: string;
	type: string;
}

interface DescribeMetricResponse {
	attributes?: MetricDescription[];
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
	// node is a synthetic attribute, so make sure it's included
	const attributes = [{ name: 'node', type: 'string' }];
	for await (const result of results) {
		for (const attr in result) {
			attributes.push({ name: attr, type: typeof result[attr] });
		}
		const desc = {
			attributes,
		};
		log.trace?.('describe_metric result:', JSON.stringify(desc));
		return desc;
	}
	// if no results, return empty object
	return {};
}
