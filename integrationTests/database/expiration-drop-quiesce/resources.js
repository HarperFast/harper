import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const controlDirectory = process.env.EXPIRATION_QUIESCE_CONTROL;

export class QuiesceControl extends Resource {
	static loadAsInstance = false;

	async post(_query, body) {
		const Table = databases[body.database]?.[body.table];
		if (!Table) return { available: false };
		if (body.action === 'seed') {
			const expiresAt = Date.now() - 10_000;
			if (body.kind === 'indexed') await Table.put(body.id, { id: body.id, expiresAt });
			else await Table.put(body.id, { id: body.id, value: 'expired' }, { expiresAt });
			return { seeded: true };
		}
		const started = join(controlDirectory, `${body.runId}.started`);
		const release = join(controlDirectory, `${body.runId}.release`);
		const hooks = {
			beforeBatchCommit: async () => {
				writeFileSync(started, 'started');
				while (!existsSync(release)) await delay(20);
			},
		};
		if (body.kind === 'indexed') await Table.runRecordExpirationSweepForTests(hooks);
		else await Table.runPrimaryCleanupScanForTests(hooks);
		return { completed: true };
	}
}
