import { table, type Table } from '../databases';

export const nodeIds = new Map<string, number>();

let AnalyticsHostnameTable: Table;
export function getAnalyticsHostnameTable() {
	if (!AnalyticsHostnameTable) {
		AnalyticsHostnameTable = table({
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
		});
	}
	return AnalyticsHostnameTable;
}
