import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrlRest, headers } from '../config/envConfig.js';

describe('22. OpenAPI', () => {
	//OpenAPI Folder

	//precondition: 'Add default component for openapi endpoint' from 19_graphQlTests.js
	//to avoid another restart and wait

	it('Get open api', async () => {
		const response = await request(envUrlRest)
			.get('/openapi')
			.set(headers)
			.expect((r) => {
				let openapi_text = JSON.stringify(r.body.openapi);
				assert.ok(!openapi_text);
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
