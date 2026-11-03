import { Resource, tables } from 'harper';
import { threadId } from 'node:worker_threads';

export class Isolated extends Resource {
	async get() {
		let rawTtlRecords = 0;
		for await (const _ of tables.IsolatedTtl.search({ includeExpired: true })) rawTtlRecords++;
		return { application: 'isolated-app', threadId, rawTtlRecords };
	}
}
