import assert from 'node:assert/strict';
import { reqRest } from './request.mjs';

export function createBlobCustom(id, checkblobMinSize, checkblobMaxSize) {
	return reqRest(`/blobcache/${id}`)
		.set('Accept', '*/*')
		.set('Cache-Control', 'no-cache')
		.expect((r) => {
			assert.ok(
				r.headers['content-length'] >= checkblobMinSize || r.headers['content-length'] <= checkblobMaxSize,
				r.text
			);
		})
		.expect(200);
}
