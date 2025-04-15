import { describe, it } from 'node:test';
import request from 'supertest';
import assert from 'node:assert';
import { envUrl, testData, headers } from '../config/envConfig.js';
import { restartWithTimeout } from '../utils/restart.js';

describe('8a. Restart HDB to update config', () => {
	//Restart HDB to update config Folder

	it('Get Configuration', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'get_configuration' })
			.expect((r) => {
				assert.ok(r.body.rootPath, r.text);
				testData.rootPath = r.body.rootPath;
			})
			.expect(200)
	});

	it('Turn on log audit and custom functions', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'set_configuration',
				logging_auditLog: true,
				customFunctions_enabled: true,
				localStudio_enabled: true
			})
			.expect(200);
	});

	it('Restart for new settings', async () => {
		await restartWithTimeout(testData.restartTimeout);
	});
});
