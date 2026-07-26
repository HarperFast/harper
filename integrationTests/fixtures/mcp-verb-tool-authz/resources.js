// QA-735 (#1940) — MCP verb-tool listing-vs-authorization divergence.
//
// #1940: MCP verb tools for a table-less programmatic Resource (no @table
// backing) list only to super-users (components/mcp/tools/application.ts
// makeVisibleTo: `if (!databaseName || !tableName) return false` for any
// non-super-user). The open question is whether that's listing-only, or the
// tool is also blindly invocable — i.e. hidden but unguarded.
//
// Four resources probe the surface (all prefixed Qa735* so they can't
// collide with QA-736's resources sharing this instance):
//
//   Qa735OpenTool   — table-less, with an explicit allowRead/allowCreate
//                override that permits ANY authenticated user (the realistic
//                shape of the #1940 report: an author builds a shared
//                utility resource meant for regular users, not just admins).
//                This is the resource whose tools are hidden from a
//                non-super-user's tools/list yet still succeed when called
//                blind by name.
//
//   Qa735StrictTool — table-less, structurally identical, but with NO allow*
//                override. Falls back to Harper's base Resource default
//                (`allowRead/allowCreate return user?.role.permission.super_user`
//                — super-user-only). Contrast case: proves the *framework*
//                default is safe even though the listing gate hides it
//                identically to Qa735OpenTool — the divergence is
//                author-dependent, not universal.
//
//   Qa735Order      — table-backed (@table @export in schema.graphql), no
//                row-level allow* override: table-level RBAC only, the same
//                gate REST enforces. Used to check whether a table-backed
//                tool's visibility (granted by table permission) matches its
//                actual invocability, and whether a tool hidden for lacking a
//                specific permission (e.g. insert) is ALSO blocked when
//                called blind (contrast against Qa735OpenTool above).
//
//   Qa735Health     — a component-author custom tool (`static mcpTools`, NOT
//                a generated verb tool). Per the documented design, custom
//                mcpTools entries are `visibleTo: () => true` — listed and
//                callable for any authenticated user regardless of table
//                RBAC. This is the harness's positive control: if a matrix
//                cell for Qa735Health comes back non-200, the harness itself
//                is broken, not Harper's authz.

function isAuthedNonAnon(user) {
	return !!user?.username;
}

export class Qa735OpenTool extends Resource {
	allowRead(user) {
		return isAuthedNonAnon(user);
	}
	allowCreate(user) {
		return isAuthedNonAnon(user);
	}
	async get(target) {
		return { id: target?.id ?? 'w1', label: `open-${target?.id ?? 'w1'}` };
	}
	async search() {
		return [{ id: 'w1', label: 'open-w1' }];
	}
	async post(target, data) {
		return { id: data?.id ?? 'created', label: data?.label ?? 'new-open' };
	}
}

export class Qa735StrictTool extends Resource {
	async get(target) {
		return { id: target?.id ?? 's1', label: `strict-${target?.id ?? 's1'}` };
	}
	async search() {
		return [{ id: 's1', label: 'strict-s1' }];
	}
	async post(target, data) {
		return { id: data?.id ?? 'created', label: data?.label ?? 'new-strict' };
	}
}

export class Qa735Order extends tables.Qa735Order {}

export class Qa735Health extends Resource {
	static mcpTools = [
		{
			name: 'qa735_health_ping',
			method: 'ping',
			description:
				'Liveness check (harness control) — visible+invocable to any authenticated user regardless of table RBAC.',
			inputSchema: { type: 'object', properties: {} },
		},
	];
	async ping() {
		return { pong: true };
	}
}

// QA-736 (#1945) — MCP `detectVerbs` (components/mcp/tools/application.ts) manufactures
// create_, update_, delete_ tool entries for EVERY Resource subclass, including ones that never
// implement the verb, because it checks `typeof prototype.post === 'function'` rather than
// comparing identity against the base class the way resources/openApi.ts does
// (`prototype.post !== Resource.prototype.post`). Resource's base class DOES define an instance
// `post` method (resources/Resource.ts ~L352 — it throws `missingMethod` unless the target is a
// collection AND the subclass implements `create`), so `typeof p.post === 'function'` is true for
// EVERY Resource subclass, manufacturing a `create_*` tool unconditionally. `put`/`patch`/`delete`
// have no such base-class default, so detectVerbs correctly does NOT manufacture update_ or delete_
// for a class that doesn't implement them — the bug is narrower than the issue title suggests: it's
// specifically `create_*` (post).
//
// Resources below probe that gap plus the authorization-contract question (does a manufactured
// verb inherit the super-user-only allow* default, or fall through unguarded), with an
// oracle-arming pair (Throwing/Permissive canaries) to prove the detection actually has teeth.
// Prefixed Qa736* so they can't collide with QA-735's resources sharing this instance.

// ── Arm 1: CONTROL — a real Table genuinely implements every CRUD verb. create_Qa736Widget is a
// correct listing (not "manufactured" in the #1945 sense); must succeed for the super-user. ──
export class Qa736Widget extends tables.Qa736Widget {}

// ── Arm 2/3: the manufactured-verb probe. Implements ONLY read (get/search) — never overrides
// post/create anywhere (instance or static) — and carries NO allow* override, so it falls back to
// Resource's base default (super-user-only, resources/Resource.ts ~L457-470). MCP nonetheless
// manufactures create_Qa736ReadOnlyThing (the #1945 bug). What happens when it's invoked? ──
export class Qa736ReadOnlyThing extends Resource {
	async get(target) {
		return { id: target?.id ?? 'r1', label: `readonly-${target?.id ?? 'r1'}` };
	}
	async search() {
		return [{ id: 'r1', label: 'readonly-r1' }];
	}
}

// ── ORACLE-ARMING CANARY #1 — deliberately throws inside create, to prove our isError/"TOOL-ERR"
// detection fires on a REAL failure (not a harness that rubber-stamps every call as clean). allowCreate
// is permissive so the throw — not authz — is what's under test. ──
export class Qa736ThrowingCanary extends Resource {
	allowCreate() {
		return true;
	}
	async get(target) {
		return { id: target?.id ?? 'c1' };
	}
	async post(_data, _target) {
		throw new Error('QA736_DELIBERATE_CANARY_THROW');
	}
}

// ── ORACLE-ARMING CANARY #2 — deliberately PERMISSIVE allowCreate (any authenticated user) with a
// real, working create — to prove our "call actually succeeded" detection fires on a REAL success
// (not a harness that rubber-stamps every call as blocked). Calibrates the arm-3 authz probe: if
// this succeeds for a non-super user but Qa736ReadOnlyThing doesn't, the difference is real. ──
export class Qa736PermissiveCanary extends Resource {
	allowCreate(user) {
		return isAuthedNonAnon(user);
	}
	async get(target) {
		return { id: target?.id ?? 'p1' };
	}
	// Default (loadAsInstance !== false) instance dispatch calls post(data, target) — the body
	// first, the RequestTarget second (resources/Resource.ts static post: `resource.post(data, query)`).
	async post(data, _target) {
		return { id: data?.id ?? 'created', ok: true };
	}
}
