// harper#1484 — resolver for the unconstrained (`Any`) @computed `Node.linked`, which returns a LIVE
// entity (another Node). The static cycle detector can't see this edge, so the table must fall to the
// guarded serialization path; two Nodes that link each other must serialize as reference stubs, not
// overflow. Exercises the "new exposure" the cross-model review flagged for computed-scalar-only tables.
// getSync returns the live decoded struct synchronously (a Promise/async get would serialize as {} and
// never cycle) — this is what makes the runtime cycle reachable during synchronous JSON serialization.
tables.Node.setComputedAttribute('linked', (record) =>
	record.linkId != null ? tables.Node.primaryStore.getSync(record.linkId) : undefined
);

// Review follow-up: `Ref.linked` is declared `String` but the resolver returns a live entity (another
// Ref). The declared scalar type made this take the raw fast path before the fix; it must now be guarded
// so two Refs linking each other serialize as reference stubs rather than overflowing.
tables.Ref.setComputedAttribute('linked', (record) =>
	record.linkId != null ? tables.Ref.primaryStore.getSync(record.linkId) : undefined
);
