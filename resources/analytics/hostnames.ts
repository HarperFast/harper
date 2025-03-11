import { table, Table } from '../databases';

let AnalyticsHostnamesTable: Table;
export function getAnalyticsHostnamesTable() {
	return (
		AnalyticsHostnamesTable ||
		(AnalyticsHostnamesTable = table({
			table: 'hdb_analytics_hostnames',
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
		}))
	);
}

export function nodeHashToNumber(nodeHash: Uint8Array): number {
	return (nodeHash[0] << 23) | (nodeHash[1] << 15) | (nodeHash[2] << 7) | nodeHash[3];
}

