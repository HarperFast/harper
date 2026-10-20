const assert = require('node:assert');
const { serialize } = require('node:v8');
const { fullTextPageResponseBytes } = require('#src/resources/indexes/fullTextQueryProtocol');

describe('full-text page response bounds', () => {
	it('bounds structured-clone replies for ASCII, Latin-1, multibyte and supplementary text', () => {
		for (const text of ['x', 'é', 'Ω', '😀', '\ud800']) {
			const maximumString = text.repeat(Math.floor(4096 / Buffer.byteLength(text)));
			const page = {
				total: Number.MAX_SAFE_INTEGER,
				totalRelation: 'lower-bound',
				continuation: text.repeat(1024),
				hits: Array.from({ length: 1000 }, () => ({
					id: maximumString,
					version: maximumString,
					score: Number.MAX_VALUE,
				})),
			};
			const reply = { id: 'a'.repeat(32), originator: Number.MAX_SAFE_INTEGER, value: page };
			assert(fullTextPageResponseBytes(page) >= serialize(reply).byteLength, text);
		}
	});
});
