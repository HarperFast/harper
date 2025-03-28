import { describe, it } from 'node:test';
import request from 'supertest';
import { envUrl, headers } from '../config/envConfig.js';
import { setTimeout } from 'node:timers/promises';

describe('8a. Restart HDB to update config', () => {
	//Restart HDB to update config Folder

	it('Turn on log audit and custom functions', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'set_configuration',
				logging_auditLog: true,
				customFunctions_enabled: true,
				localStudio_enabled: true,
				clustering_enabled: true,
				replication_url: null,
			})
			.expect(200);
	});

	it('Restart for new settings', async () => {
		const response = await request(envUrl).post('').set(headers).send({ operation: 'restart' }).expect(200);
		await setTimeout(60000);
	});
});
