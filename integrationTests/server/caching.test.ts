/**
 * Caching integration tests.
 *
 * sourcedFrom cache miss/hit, invalidation, stale-while-revalidate, and stampede
 * are comprehensively covered by unitTests/resources/caching.test.js.
 * This integration test focuses on scenarios requiring a live Harper instance
 * that the unit suite cannot cover.
 */
import { test } from 'node:test';

test.todo(
	'replicationSource: true — sourcedFrom fetches on replica node, not origin (needs a 2-node cluster harness; originally scoped in #1189, closed without this case)'
);
