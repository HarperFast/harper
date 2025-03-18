import { table, type Table } from '../databases';

export const nodeIds = new Map<string, number>();

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
