import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testData } from '../config/envConfig.js';
import { restartWithTimeout } from '../utils/restart.js';
import { req } from '../utils/request.js';

describe('8a. Restart HDB to update config', () => {
	//Restart HDB to update config Folder

	it('Get Configuration', async () => {
		await req()
			.send({ operation: 'get_configuration' })
			.expect((r) => {
				assert.ok(r.body.rootPath, r.text);
				testData.rootPath = r.body.rootPath;
			})
			.expect(200)
	});

	it('Turn on log audit and custom functions', async () => {
		await req()
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
