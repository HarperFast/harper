export interface StoredRecord {
	id: string;
	[field: string]: unknown;
}
export interface Reply<Body = Record<string, unknown>> {
	status: number;
	body: Body;
}
export interface ChainBody {
	id: string;
	hops: number;
	records: { id: string; owner: string; next: string; field1: unknown; field2: unknown }[];
}
export function parseLink(record: StoredRecord): { next: string; owner: string };
export function inspectRecord(record: StoredRecord, caller: string | undefined): Reply;
export function parseHops(value: unknown): number | undefined;
export function chainRecords(
	fetchRecord: (id: string) => StoredRecord | undefined | Promise<StoredRecord | undefined>,
	id: string,
	hops: number
): Promise<Reply<ChainBody>>;
