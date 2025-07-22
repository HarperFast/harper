import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reqRest } from '../utils/request.js';

describe('22. OpenAPI', () => {
	//OpenAPI Folder

	it('Get open api', () => {
		return reqRest('/openapi')
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
