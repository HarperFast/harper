import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, envUrlRest, generic, headers } from '../config/envConfig.js';
import { setTimeout } from 'node:timers/promises';
import { restartWithTimeout } from '../utils/restart.js';

describe('22. OpenAPI', () => {
	//OpenAPI Folder

	it('Add default component for openapi endpoint', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ 'operation': 'add_component', 'project': 'myApp111' })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes('Successfully added project') ||
				JSON.stringify(r.body).includes('Project already exists')))
	});

	it('Restart service and wait', async () => {
		await restartWithTimeout(generic.restartTimeout);
	});

	it('Get open api', async () => {
		const response = await request(envUrlRest)
			.get('/openapi')
			.set(headers)
			.expect((r) => {
				let openapi_text = JSON.stringify(r.body.openapi);
				console.log(openapi_text);
				assert.ok(openapi_text);
				assert.ok(r.body.info.title.includes('HarperDB HTTP REST interface'));
				assert.ok(r.body.paths);
				assert.ok(r.body.paths.hasOwnProperty('/TableName/'));
				assert.ok(r.body.paths.hasOwnProperty('/TableName/{id}'));
				assert.ok(r.body.paths.hasOwnProperty('/Greeting/'));

				let paths_text = JSON.stringify(r.body.paths);
				assert.ok(paths_text.includes('post'));
				assert.ok(paths_text.includes('get'));
				assert.ok(r.body.components);
				assert.ok(r.body.components.schemas);
				assert.ok(r.body.components.schemas.TableName);
				assert.ok(r.body.components.schemas.Greeting);
				assert.ok(r.body.components.securitySchemes);
				assert.ok(r.body.components.securitySchemes.basicAuth);
				assert.ok(r.body.components.securitySchemes.bearerAuth);
			})
			.expect(200);
	});
});
