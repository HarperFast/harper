'use strict';

/**
 * Protocol visibility for the `/v1/*` gateway registrations (#631, PR #1616 review).
 *
 * Without an exportTypes policy, entries in the shared registry match every
 * protocol lookup — WS dispatch could reach V1ChatCompletions.connect() and fail
 * iterating its non-iterable badRequest envelope, and the endpoints would surface
 * through MQTT/GraphQL/MCP enumeration. The gateway registers REST for all three,
 * SSE for chat only, and false for everything else.
 */

const assert = require('node:assert');
require('#src/resources/databases');
const { Resources } = require('#src/resources/Resources');
const { handleApplication } = require('#src/resources/models/v1/index');
const { V1Models } = require('#src/resources/models/v1/models');
const { V1ChatCompletions } = require('#src/resources/models/v1/chatCompletions');

describe('/v1 gateway protocol routing', () => {
	let resources;
	beforeEach(() => {
		resources = new Resources();
		handleApplication({ options: { get: () => true, on: () => {} }, resources });
	});

	it('serves all three endpoints over REST', () => {
		assert.equal(resources.getMatch('v1/models', 'rest')?.Resource, V1Models);
		assert.ok(resources.getMatch('v1/embeddings', 'rest'));
		assert.equal(resources.getMatch('v1/chat/completions', 'rest')?.Resource, V1ChatCompletions);
	});

	it('serves SSE for chat only (explicit Accept: text/event-stream dispatch)', () => {
		assert.equal(resources.getMatch('v1/chat/completions', 'sse')?.Resource, V1ChatCompletions);
		assert.equal(resources.getMatch('v1/models', 'sse'), undefined);
		assert.equal(resources.getMatch('v1/embeddings', 'sse'), undefined);
	});

	for (const protocol of ['ws', 'mqtt', 'graphql', 'mcp']) {
		it(`is invisible to ${protocol} lookups`, () => {
			assert.equal(resources.getMatch('v1/models', protocol), undefined);
			assert.equal(resources.getMatch('v1/embeddings', protocol), undefined);
			assert.equal(resources.getMatch('v1/chat/completions', protocol), undefined);
		});
	}
});
