import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testData } from '../config/envConfig.mjs';
import { restartWithTimeout } from '../utils/restart.mjs';
import { req } from '../utils/request.mjs';

describe('8a. Restart HDB to update config', () => {
	//Restart HDB to update config Folder

	it('Get Configuration', () => {
		return req()
			.send({ operation: 'get_configuration' })
			.expect((r) => {
				assert.ok(r.body.rootPath, r.text);
				testData.rootPath = r.body.rootPath;
			})
			.expect(200);
	});

	it('Turn on log audit and custom functions', () => {
		return req()
			.send({
				operation: 'set_configuration',
				logging_auditLog: true,
				customFunctions_enabled: true,
				localStudio_enabled: true,
			})
			.expect(200);
	});

	it('Restart for new settings', () => {
		return restartWithTimeout(testData.restartTimeout);
	});
});
