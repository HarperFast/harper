/**
 * Harper's side of the dependent-read workloads (the Fastify side is in
 * ../../ycsb-vs-pg/pg-app/server.mjs; the shared work is in dependentReads.mjs):
 *   GET /inspect/<id>          -> 200 projection, or 403 unless the caller owns the record
 *   GET /chain/<id>?hops=<n>   -> n + 1 dependent reads, one composed response
 *
 * The caller is the authenticated user under --auth=token (YCSB_AUTH=token) and the `x-caller`
 * header otherwise, where local trust admits every request.
 */
import { Resource, tables } from 'harper';
import { chainRecords, inspectRecord, parseHops } from './dependentReads.mjs';

const callerFromPrincipal = process.env.YCSB_AUTH === 'token';

function reply({ status, body }) {
	return status === 200 ? body : { status, headers: {}, data: body };
}

export class inspect extends Resource {
	static loadAsInstance = false;

	async get(target) {
		const user = this.getCurrentUser();
		if (!user) return reply({ status: 401, body: { error: 'unauthorized' } });
		const caller = callerFromPrincipal ? user.username : this.getContext().headers.get('x-caller');
		const record = await tables.usertable.get(target.id, this);
		if (!record) return undefined;
		return reply(inspectRecord(record, caller));
	}
}

export class chain extends Resource {
	static loadAsInstance = false;

	async get(target) {
		if (!this.getCurrentUser()) return reply({ status: 401, body: { error: 'unauthorized' } });
		const hops = parseHops(target.get('hops'));
		if (hops === undefined) return reply({ status: 400, body: { error: 'hops must be an integer in [0, 8]' } });
		return reply(await chainRecords((id) => tables.usertable.get(id, this), target.id, hops));
	}
}
