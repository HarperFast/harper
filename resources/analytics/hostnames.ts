import { table, Table } from '../databases';

export const hostnameIds = new Map<string, number>();

let AnalyticsHostnamesTable: Table;
export function getAnalyticsHostnameTable() {
	return (
		AnalyticsHostnamesTable ||
		(AnalyticsHostnamesTable = table({
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
		}))
	);
}

export function nodeHashToNumber(nodeHash: Uint8Array): number {
	return (nodeHash[0] << 23) | (nodeHash[1] << 15) | (nodeHash[2] << 7) | nodeHash[3];
}
