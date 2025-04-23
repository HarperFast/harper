export const METRIC = {
	TABLE_SIZE: 'table-size',
	DATABASE_SIZE: 'database-size',
	STORAGE_VOLUME: 'storage-volume',
	MAIN_THREAD_UTILIZATION: 'main-thread-utilization',
	RESOURCE_USAGE: 'resource-usage',
	UTILIZATION: 'utilization',
} as const;

export type BuiltInMetricName = (typeof METRIC)[keyof typeof METRIC];
