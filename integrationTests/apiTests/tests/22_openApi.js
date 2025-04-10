import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, envUrlRest, testData, headers } from '../config/envConfig.js';
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
		await restartWithTimeout(testData.restartTimeout);
	});

	it('Get open api', async () => {
		const response = await request(envUrlRest)
			.get('/openapi')
			.set(headers)
			.expect((r) => {
				let openapi_text = JSON.stringify(r.body.openapi);
				console.log(openapi_text);
				assert.ok(openapi_text, r.text);
				assert.ok(r.body.info.title.includes('HarperDB HTTP REST interface'), r.text);
				assert.ok(r.body.paths, r.text);
				assert.ok(r.body.paths.hasOwnProperty('/TableName/'), r.text);
				assert.ok(r.body.paths.hasOwnProperty('/TableName/{id}'), r.text);
				assert.ok(r.body.paths.hasOwnProperty('/Greeting/'), r.text);

				let paths_text = JSON.stringify(r.body.paths);
				assert.ok(paths_text.includes('post'), r.text);
				assert.ok(paths_text.includes('get'), r.text);
				assert.ok(r.body.components, r.text);
				assert.ok(r.body.components.schemas, r.text);
				assert.ok(r.body.components.schemas.TableName, r.text);
				assert.ok(r.body.components.schemas.Greeting, r.text);
				assert.ok(r.body.components.securitySchemes, r.text);
				assert.ok(r.body.components.securitySchemes.basicAuth, r.text);
				assert.ok(r.body.components.securitySchemes.bearerAuth, r.text);
			})
			.expect(200);
	});
});
