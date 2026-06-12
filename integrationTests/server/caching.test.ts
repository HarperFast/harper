/**
 * Caching integration tests.
 *
 * sourcedFrom cache miss/hit, invalidation, stale-while-revalidate, and stampede
 * are comprehensively covered by unitTests/resources/caching.test.js.
 * This integration test focuses on scenarios requiring a live Harper instance
 * that the unit suite cannot cover.
 *
 * TODO: replicationSource: true (sourcedFrom fetches on replica node, not origin)
 * requires a 2-node cluster setup — tracked in
 * https://github.com/HarperFast/harper/issues/1189.
 * See integrationTests/ for existing infrastructure patterns once a cluster harness
 * is available.
 */
