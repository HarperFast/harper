# security/ — Design notes

Authentication tokens, OIDC exchange and TLS material.

**Read this when:** touching `tokenAuthentication.ts`, `impersonation.ts`, `authn/oidc/`, `keys.ts`, `certificateVerification/` or role attribute permissions.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## OIDC trusted publishing (`security/authn/oidc/`)

`exchange_oidc_token` lets a workload authenticate with no stored Harper credential (#2171): it presents an identity token minted by its runtime, and gets back a one-hour operation token for the user a stored trust policy names. It is in `NO_AUTH_OPERATIONS` because it _is_ the authentication, like `create_authentication_tokens` against a password, with the same three wiring points (`server/serverHelpers/serverHandlers.ts` `NO_AUTH_OPERATIONS`, the `verifyPerms` bypass in `serverUtilities.ts`, and a `permission(false, [], OPERATIONS_ENUM.EXCHANGE_OIDC_TOKEN)` registration).

**The core is issuer-agnostic; everything issuer-specific lives in `providers/`.** That split is the point of the layout, not an accident of it — a new workload-identity issuer should be a profile, not a change to verification, matching, or storage.

- `claims.ts` — matching and constraint _shape_ validation. Knows nothing about any issuer.
- `jwks.ts` — issuer keys. The rate-limit clock for unknown-`kid` refetches lives _outside_ the cache entry: a successful fetch replaces the entry, and a rate limit that resets whenever it fires is not a rate limit. Keeping it separate also means a genuine key rotation is picked up on first use rather than after the window.
- `identityToken.ts` — signature, issuer, audience, `exp`, and a bounded lifetime. Owns `rejectToken`, shared with the exchange so both halves refuse identically.
- `tokenExchange.ts` — policy selection, replay, minting, audit. Verification is memoized per audience, so N policies sharing one cost one signature check.
- `providers/` — `assertPolicyIsSpecific` / `assertAudienceIsSpecific` / `normalizeClaims` / `describePrincipal` / optional `vetoClaims`, resolved by normalized issuer.

**An unregistered issuer gets `providers/generic.ts`, which is strict rather than permissive:** the policy must pin `sub`. That is what makes Kubernetes service accounts, GCP service accounts, and SPIFFE SVIDs work with zero provider code — each has a stable canonical subject. GitHub needs its own profile precisely because its `sub` is the one claim you should _not_ pin: it varies by trigger, and its format changed for repositories created after 2026-07-15.

Five constraints that look like choices but are not:

1. **Every rejection returns the same message.** The endpoint is unauthenticated; a caller told which check failed can enumerate a policy one claim at a time. Reasons go to the `oidc-trust` logger.
2. **A GitHub policy must gate the ref.** `githubActionsProfile.assertPolicyIsSpecific` rejects a policy pinning only repository + workflow, because anyone who can push a branch could then add that workflow to it and mint a token. Stricter than npm's trusted-publishing model, which mitigates the same hole with environment protection instead — and profile-scoped, so it never constrains another issuer.
3. **`createOperationToken`, not `createTokens`.** `createTokens` overwrites `hdb_user.refresh_token` as a side effect, so minting for CI would silently revoke whatever credential that user already held (#2018) — the exact problem this feature removes.
4. **The role is the boundary; the per-policy `operations` allowlist only narrows it.** Least privilege is primarily the role of the user the policy names. A policy may _optionally_ carry an `operations` scope, which can only subtract from that role — never add to it. It is deliberately not merged into `permission.operations`: gate 2 in `operation_authorization.ts` treats an explicit listing of an SU-only operation as a deliberate grant, so reusing that field would _widen_ where this must only narrow. The scope is carried as a separate `tokenOperations` claim and intersected ahead of every early return, including the super_user bypass.

   Its enforcement surface is the operations API and SQL (`verifyPerms` / `verifyPermsAST`) — **not** the application REST/GraphQL resource path, which authorizes through table-level `checkPermission` and does not consult the scope. A scoped token therefore still carries its role's full CRUD there, which is why the role has to be least-privilege on its own; the scope is defense in depth, not a substitute. Closing that gap is tracked in #2201. Whether to keep a second authorization mechanism beside roles at all, one more place for the two to disagree, was left open in #2173.

   Naming `sql` in a scope grants the SQL interface, not unrestricted DML through it: a write statement additionally requires its matching data operation (`insert`/`update`/`delete`) in scope. That is what keeps `read_only` — which expands to include `sql` — from admitting a DELETE, given that `verifyPermsAST` returns early for a super_user before any table check runs.

5. **Policy ids never choose authority.** The exchange refuses, unspent, a token two enabled policies give different users or operations, since no write can exclude such a pair across nodes; agreeing policies answer with the first by id.

`hdb_oidc_token_use` (declared on every node at every start by `tokenUseTable.ts`, so a node that never exchanges still removes the rows replicated to it — see dataLayer/DESIGN.md, "System table bootstrap") records spent tokens keyed on a SHA-256 of the token itself, each expiring (record metadata, replicated with the row) past the token's own expiry. Hashed rather than stored, so the table never holds a credential; keyed on the token's **signed input** (`header.payload`) rather than `jti` because not every issuer emits one (Azure uses `uti`). Not on the whole token string: the signature segment is covered by nothing, and base64url decoding ignores the surplus low bits of its final character, so 16 distinct spellings of an RS256 signature decode to the same bytes, all verify, and all hash differently — one leaked token would buy 16 exchanges. ES\* malleability (`s → n−s`) is a second such vector. The signed input is exactly what the issuer asserted, so every variant collapses to one fingerprint. The get-then-put is not atomic and does not claim to be: a concurrent replay is not a privilege escalation, since whoever holds the token could obtain one operation token anyway.

**The minted token carries where the run came from.** Beside `workload_identity`, the exchange signs a `deploy_source` claim: `{ via: 'oidc', policy, … }` with the run's verified `repository`, `sha`, `ref`, `workflow_ref`, `run_id`, `run_attempt`, `actor` and `environment`, whichever the identity token holds (`attestedSource`, `components/deploymentSource.ts`). `validateToken` lifts it onto the principal as `deploySource` and impersonation carries it, like the provenance marker, and `deploy_component` records it on the deployment row as attested, where it wins over anything the request declares (#3061). Signed, so a caller cannot edit it; claims, not the token, so the record holds no credential.

`harper deploy setup=true provider=github-actions` (`bin/deploySetupGithubActions.ts`) is the client-side composition of these operations for one repository's workflow: role and user `<component>-ci-deploy` (`deploy_component`, `get_deployment`, `get_job`, `registration_info`) and policy `github-actions-<component>`, names Studio's setup must match. It only creates: a record that already matches is left alone, and one that differs or was deactivated stops it before it writes, so it does not repurpose a role or undo a revocation. `add_oidc_trust` replaces, so setup lists the policy again just before writing it; a policy another super user creates (enabled or not) in that last round trip would still be overwritten. A server-side create-only write would narrow that further but not close it, since `hdb_oidc_trust` replicates and the check would be per node. It reads the policy back and compares it claim for claim, because a mismatch otherwise surfaces only as the exchange's opaque 401.

## Scoped tokens and synthetic-role identity (`security/tokenAuthentication.ts`, `security/impersonation.ts`)

`create_authentication_tokens` with an inline `role` **object** mints a `sub: 'scoped-operation'`
JWT that embeds its whole (downgraded, deep-validated) permission set; the bearer needs no
`hdb_user`/`hdb_role` row and the `username` is attribution only. Minting is super_user-gated
(or trusted internal dispatch via `isOperationAuthorizationBypassed()`); a string `role` keeps its
legacy meaning (component-defined token, rejected by `validateOperationToken`). Scoped tokens get
no refresh token, touch no user record, and are therefore **irrevocable until expiry** — expiry is
the only control, which is why `auth.ts` evicts cached Bearer identities at exact `authExpiresAt`
rather than waiting for the auth-cache TTL.

The attribution `username` must NOT name an existing `hdb_user` (rejected at mint; the default is
`scoped:<minter>`): code paths that rehydrate a user by name would otherwise substitute the real
principal's permissions for the token's — or fail-closed on the non-existent name. The three known
by-name sites are handled, all by the same `_scopedToken` short-circuit: the MQTT last-will replay
(`DurableSubscriptionsSession.ts` persists the scoped role/marker/expiry on the will and skips
rehydration — and both the restart-replay and the live abnormal-disconnect paths refuse to publish
a scoped will past `authExpiresAt`), the live-subscription stale-auth recheck (`Resource.ts`
`registerLiveSubscriptionForContext` keeps the embedded role as the identity), and the MCP
`list_changed` session refresh (`components/mcp/listChanged.ts` `refreshSessionUser`). The scoped
principal also cannot self-mint standing tokens: the passwordless path of `createTokens` rejects an
`hdb_user._scopedToken` requester. **Any future by-name rehydration must check `_scopedToken`** (and
`isLocalPrincipal`, below). A
user _created after minting_ with a colliding name is therefore inert at every current site; the
residual is only some _new_ unguarded by-name site — another reason to prefer short expiries.

Scope of the `operations` allowlist: it gates the **operations API** (including the `sql` path,
which never reaches `verifyPerms` and calls `verifyOperationsAllowlist` directly from
`chooseOperation`) — it does NOT gate the application/REST/GraphQL/MQTT surfaces, which authorize
on translated table CRUD permissions only. A scoped token intended to be read-only on app
endpoints must carry restrictive table permissions; `operations: ['read_only']` alone does not
constrain REST writes if table perms allow them.

Which name the allowlist is checked against: `verifyPerms` is handed the handler, not the invoked
operation, so gate 1 checks the registered entry's `api_name`, and never the handler's own name —
only a name with no registration at all (`sql`) is checked as given. The `permission` constructor
requires that argument: an API name, or `null` when no allowlist may grant the operation. Leaving it
out is a compile error, which closes the old failure where an omitted name made gate 1 fall back to
the handler name — refusing every role that listed the operation, unless the handler name happened
to equal the API name, when it silently granted it instead.
Aliases share a handler, so listing the canonical name grants both spellings and the alias spelling
grants neither. `get_backup`, `read_transaction_log` and `catchup` are registered with `null`: gate 2
would grant `get_backup` ahead of its READ check on a whole-database copy, `read_transaction_log`
lacks `read_audit_log`'s `system.hdb_secret` guard, and the legacy `catchup` applies writes to any
table with no table permission check. A test in `unitTests/utility/operation_authorization.test.js`
holds every dispatched operation to this.

The invariant to preserve when touching any synthetic (inline/impersonated/scoped) role:
`permissionsTranslator.getRolePermissions` memoizes translated permissions **by role name** (keyed
further by `__updatedtime__` + schema). A synthetic role must therefore never carry a constant
name or a per-request timestamp — two different permission sets would alias one cache slot (a
same-millisecond `Date.now()` was enough), leaking one principal's translated permissions to
another. `syntheticRoleName()` derives the name from a hash of the post-downgrade permission
content with `__updatedtime__: 0`, so identical sets share a slot and distinct sets can't collide;
`applyImpersonation` re-keys all three impersonation modes the same way. Synthetic translations live in a separate
256-entry LRU (`syntheticRolePermsMap`), not the permanent `rolePermsMap` — so >256 concurrently
live distinct permission sets degrade to per-request translation (a deliberate cliff; raise the
constant if a legitimate workload hits it). The `_` name prefix is the discriminator; a persisted
role named with a leading underscore lands in the LRU too (correct, just evictable). Relatedly,
the role `operations` allowlist gate in `verifyPerms` must stay **ahead of** the ambient privilege
early-returns (super_user, structure_user, system-table allowances): persisted roles can't combine
`super_user` with other permission keys, but inline roles can combine `structure_user` with an
allowlist, and the gate ordering is what keeps unlisted schema ops unreachable.

## TLS hot-reload publishes matching configured pairs (`security/keys.ts`)

`loadCertificates` publishes a configured leaf only after `X509Certificate.checkPrivateKey` validates the stored PEM. Only the main thread watches the cert and key directories; its filtered shallow watches and five-minute poll share one cert/key fingerprint. An incomplete pair returns `false` and is retried, warning, then erroring after 30 s (at once when the name has no non-self-signed record) and hourly after. Restoring the last applied files after an aborted renewal re-enters the loader, clearing the alarm. Every raw watcher event also arms one trailing check (at most once a second, never postponed) that loads a fingerprint not yet attempted, because chokidar stops emitting add/change for a name removed twice within its 100 ms removal throttle; events the OS never delivers are left to the optional poll. CA-only records remain independent of the leaf key. Workers reload on the `hdb_certificate` subscription and read configured key files when building contexts; no worker watcher or poll races it. File-populated `getPrivateKeys()` entries are refreshed for retrieval and rebuilds, keeping the cached value while the file is unreadable; an explicit value that differs from the last file-derived key takes precedence. An unreadable directory falls back to Node file polling, armed while configured files are absent, independent of the five-minute poll. Enforced by the rename-order, per-worker, poll-disabled cases in `integrationTests/security/cert-key-reload.test.ts` and loader tests in `unitTests/security/keys.test.js` and `unitTests/security/tlsFileWatch.test.js`.

The older-file guard does not freeze a record's `ciphers`/`uses`: listeners read them from the record, so the loader marks every record it writes `from_config: true` and, at load, patches a config edit to either field onto a marked record whose PEM equals the file's (a removed `ciphers` is stored as `null`). `file_timestamp` cannot be the ownership signal: `setCertTable` patches, so an API write keeps it. `setCertTable` nulls the marker when a write sets `ciphers` or `uses`, so those set through the API (for example a lowered `@SECLEVEL` for legacy client chains) survive restarts. A record from before the marker is adopted only when it already matches config, because an operator edit is indistinguishable from stale state. When config entries share a certificate file, the first entry to reach a record owns its reconciliation at load, but a full write (first load, or a renewal whose watcher fires first) is made by whichever entry runs last or first, so the record's `uses` and `ciphers` can differ from the load-time owner's until the next restart, and a listener that reads that record uses them. A record the loader declines to change, because it differs but was not written from config, is logged. Changes apply at process start or file change, not on `restart_service`. `hostnames` and `private_key_name` stay frozen by the guard. Enforced by the `ciphers and uses follow config` cases in `unitTests/security/keys.test.js`.

An unrelated table notification during a key-first installation gap, or a second rotation between publication and a worker's key read, can still produce a transient mismatch; the trust-aware last-good retention below protects serving while the next complete pair propagates. The older-file guard still prevents disk from replacing a newer replicated certificate.

**Publication is transactional (#2382).** `updateTLS` builds the replacement hostname→context map, CA map and default candidate pass-locally, then reconciles the live maps in place (their identity is load-bearing: `server.secureContexts` and each context's `availableCAs` alias them). A record still in the table that fails to build (`ERR_OSSL_X509_KEY_VALUES_MISMATCH` when the table's cert outruns the on-disk key, a missing key on this thread) keeps its live entries _and_ its default candidacy, so a transient mismatch never serves below last-good. Retention is trust-aware: when the CA set changed since the context froze its `ca:` list, the retained pair is rebuilt against current trust (established sessions and process-wide ticket keys are unaffected, as on a fresh build); if that rebuild fails its entries drop for the pass, unless nothing else is servable, when the zero-certificate guard retains the old state while retrying. Deleting the record drops its contexts; a corrupt authority row is a pass failure and its trust drops until it heals. A failed pass self-retries on the shared debounce with a per-signature backoff (1.5s doubling to 5min) and signature-throttled logging; the table subscription stays on the plain debounce. `loadAndWatch` latches its cert/key fingerprint before the callback but rolls it back on a false result, throw or rejection (equality-guarded against a stale rejection): the latch means "last successfully applied", so the poll can heal a lost `hdb_certificate` write.

**A pass reads the certificate table as the system (harper-pro#1189).** `initialize()` can first run inside a request (harper-pro opens a replication connection from a non-owner read), so `updateTLS` re-enters itself under `contextStorage.exit()` (`run(undefined, …)` on every runtime; the async_hooks storage's native `exit()`, Node 22's default, leaks the request back after a nested `run()`, see `resources/DESIGN.md`). Inside the request, its static `hdb_certificate` calls would run that request's authorization (an anonymous one is denied) and consume its one-shot `authorize`, and the selector's timers and subscription would keep the request's context. A pass that fails before `.ready` settles still rejects it, but the attempt is not abandoned: a live selector's attempt keeps its subscription and retries on the failure backoff, because a listener calls `initialize()` once and depends on the selector recovering by itself; on recovery `.ready` is replaced with the resolved state. A later `initialize()` replaces a still-failing attempt (timers cleared, subscription ended) with a fresh one, and a one-shot selector's attempt is retired at once. `.ready` keeps the rejected promise until one of those: the Bun listener path reads it directly and would take `undefined` for "no TLS". Enforced by the `createTLSSelector initialized by a request` cases in `unitTests/security/keys.test.js`.

## Self-signed renewal replaces the pair in one transaction (`security/keys.ts`)

`prepareSelfSignedCerts` builds the self-signed CA and replication-certificate records in memory; `publishSelfSignedCerts` writes them in one `transaction()`, and for `renewSelfSigned` also deletes the old self-signed rows there. Writing new rows first is not enough on its own: `setCertTable` patches by name, and the CA name repeats when `node.hostname` is set, so a non-atomic renewal can replace the CA and then fail before the leaf. Renewal looks for a reusable CA and replication certificate with self-signed rows excluded (`getCertAuthority(true)`, `getReplicationCert(true)`), since a self-signed `replication` leaf would otherwise outscore an external generic one. Publication re-reads each row in the transaction and does not replace or delete one that is not self-signed: renewal fails instead, and boot review warns and skips it (and the leaf, when it is the CA). When an external row already holds the node name, the self-signed leaf is stored as `<node>-self-signed`; selection is by hostname, not row name. A same-key write landing inside the commit window itself is not covered. A configured key path names the CA key only when that key parsed; a generated key is created exclusively (`wx`, `0o600`) in `keys/` after the records are built, never overwrites a configured or existing file, and is removed if publication fails. Enforced by the self-signed review and renewal cases in `unitTests/security/keys.test.js` and `integrationTests/security/renew-certs-missing-privatekey.test.ts`.

## Client-certificate revocation checking keeps three tables (`security/certificateVerification/`)

`verificationTables.ts` declares them, and every writable start and the verification path apply the same
declarations (dataLayer/DESIGN.md, "System table bootstrap"). A row's expiry is record metadata; a table's
`expiration` is only the fallback for a row written without one.

- A verdict (`hdb_certificate_cache`) expires `cacheTtl` after its check because `CertificateVerificationSource`
  sets `context.expiresAt`: a caching table decides staleness by the stored expiry, and a source fill stores
  `sourceContext.expiresAt`, never a field the source returns. `createCacheKey` hashes a key version, so a
  verdict cached before verdicts carried an expiry, which has none and would read as fresh forever, is never
  read again.
- A revocation (`hdb_revoked_certificates`) lives until `crl_next_update + gracePeriod`, the window
  `performCRLCheck` honors while it decides by `crl_next_update`. Expiring it at `nextUpdate` made that branch
  unreachable and reported a revoked certificate on an overdue CRL as good.
- A CRL's revocations replace the previous set all or nothing, in a transaction of their own rather than the
  verdict fill's `performCRLCheck` runs in, so other checks see a complete set once it commits. The check that
  downloaded the CRL decides from the CRL itself: by the time it could read the table, another worker may have
  replaced the set with a different generation of that CRL. A check answered by a cached CRL reads the table
  outside the verdict fill's transaction, whose LMDB snapshot misses rows committed after it.

## A component-facing export needs BOTH `index.ts` and `getHarperExports` (`security/jsLoader.ts`, `index.ts`)

Adding `export { x } from './…'` to `index.ts` publishes `x` on the `harper` **package** but does not
make `import { x } from 'harper'` work inside an application. A component loaded into a VM compartment
resolves `harper` to a synthetic module built from `getHarperExports()` — a hand-maintained object
literal, not a re-export of `index.ts` — so a value added to only one list fails at component load with
`The requested module 'harper' does not provide an export named 'x'`. No unit test sees that, because
unit tests `require('#src/…')` directly; only a fixture that imports from `'harper'` does
(`integrationTests/security/fixtures/deferred-credential-rejection/resources.js`, harper#2703).

Export the value from the module that _defines_ it rather than re-exporting it through an intermediate,
so a component-created value shares that module's private symbols. `markCredentialRejection` depends on
this: its tag is a module-private `Symbol` that `isCredentialRejection` checks by identity.

## Both application loaders resolve through one `resolveModule` (`security/jsLoader.ts`)

The VM loader and the compartment `resolveHook` call the same module-scope `resolveModule`, so a
dependency that resolves in one `applications.moduleLoader` mode resolves in the other. It resolves
CommonJS-first (a dual package keeps its `require` target) and falls back to the package's `exports`
map only for an import of a bare specifier the CommonJS resolver rejects: `ERR_PACKAGE_PATH_NOT_EXPORTED`,
or `MODULE_NOT_FOUND` on Bun. A `require()` never falls back — the CommonJS resolver's verdict is the
runtime's own `require` resolution. The fallback is a port of Node's `PACKAGE_EXPORTS_RESOLVE` with only
the `node` and `import` conditions (plus `bun` on Bun) — Node's `module-sync`, `node-addons` and
`--conditions` are not modeled — and the `resolves package exports as native Node import does` cases check
each rule against native Node. A
fallback resolution records the `package.json` and entry-file digests, not a resolution edge, because
`RuntimeModuleTracker` re-resolves edges with `createRequire` and would read the import-only package as
changed on every deploy.

SES loads from the ESM shims `ses/index.js` composes, through `loadSES`, never `require('ses')`: that
bundle is CommonJS, Bun drops function-level `'use strict'` in CommonJS, and SES's sloppy-mode self-check
then throws `SES_NO_SLOPPY`. Lockdown and the compartment share that one SES instance. Enforced by the
`pure-ESM package resolution` blocks in `unitTests/security/jsLoader/jsLoader.test.js` (both modes) and
`integrationTests/components/compartment-pure-esm-dependency.test.ts` (Node and Bun shards).

## `require()` and `import` pass the same gates in the VM loader (`security/jsLoader.ts`)

In `vm` and `vm-current-context` modes a module reaches application code through four entry points: the
ESM `linker`, the two `importModuleDynamically` hooks, and the CommonJS `cjsRequire`. Each applies, in
order: the `'harper'` alias, `checkAllowedModulePath` (allowedDirectory for files, allowedBuiltInModules
for builtins, and the substitute it returns, such as the constrained `child_process`), the
`shouldUseApplicationLoader` app-vs-native decision, and for app-loaded files `readApplicationModule`
(record the bytes as read, strip TypeScript). `require()` differs only in loading synchronously: native
is `require(path)` rather than `import()`. A new entry point, or a new branch in one, owes all four.
A CommonJS or natively loaded file keeps the route whichever form loaded it first chose: `cjsCache`
(app-loaded CommonJS) and `nativeModules` (natively loaded, registered before a native `require()`
evaluates or a native `import()` settles, released if that fails without loading the file) are keyed
by URL and consulted by both `require()` and `import`, so a file reached by two
specifiers that would route differently has one instance per scope. Not covered: an ESM file the
application loader evaluated lives only in `moduleCache`, so a bare-specifier `require()` of it under
`dependencyLoader: native` gets Node's `require(esm)` instance; a JSON import is its own default-only
module. Both caches hold only modules that passed the check, which is why a repeat returns from them
before checking again. Only a compile error of a module's own CommonJS
wrapper selects the ESM retry in `createModuleFromSource`; an error thrown while it runs propagates.
Not covered: compartment mode's `importHook`, and what natively loaded packages require themselves.
Enforced by the `CommonJS require` blocks in `unitTests/security/jsLoader/jsLoader.test.js` and
`integrationTests/components/cjs-require-loader.test.ts`.

## The compartment `importHook` checks `allowedPath` before any branch loads a module (`security/jsLoader.ts`)

`checkAllowedModulePath` runs once at the top of the compartment `importHook`, after the synthetic `harper`
return and ahead of branch selection, so the `.node`, plain-file (`.js`, `.ts`, `.json`) and native-import
branches cannot load a module it has not approved, and a branch added later inherits it (#3485). Each branch
used to make its own call and the plain-file branch made none, so compartment mode loaded any file a relative,
absolute or symlinked specifier reached while VM mode's ESM loader (`createModule`) refused it. This applies
the existing prefix test only; it is not a containment boundary (#1929 and #2970 track that test's prefix and
realpath gaps), and files a natively loaded dependency loads itself are outside it. Enforced by the
`compartment importHook` block in `unitTests/security/jsLoader/jsLoader.test.js` and
`integrationTests/components/compartment-allowed-directory.test.ts`.

## The compartment adds a CommonJS dependency's dynamic names to its native namespace (`security/jsLoader.ts`)

A bare or `node_modules` import in the compartment `importHook` is a native `import()`. For a CommonJS
module, `dynamicCjsExports` copies the enumerable `module.exports` data properties the namespace lacks
(leaving accessors uninvoked and skipping any Proxy trap that throws) while every namespace key and the native
`default` stay as they were (#3485). The module is found through its `require.cache` entry because Node 22
gives a CommonJS namespace no `'module.exports'` key. `normalizeImportedModule` is not used here: it is a
no-op on Node 22, and where the key exists it rebuilds the exports from enumerable properties, dropping names
such as `Object.defineProperty(exports, ...)` and replacing a transpiled module's `default`. The VM loaders
still use it. Enforced by the `CommonJS dependencies imported natively` block in
`unitTests/security/jsLoader/jsLoader.test.js`.

## Authentication converts every principal-resolution failure into a decision (`security/auth.ts`)

`authentication()` resolves a principal from three sources — an mTLS certificate CN, the `Authorization`
header, and the `hdb_session` cookie — each through the overridable `server.getUser`. A failure from any
of them must become a **decision**, never a throw: an internal fault (and anything on the operations API,
where Harper owns every route) is answered in place, and a tagged credential rejection is deferred so the
layer owning the route settles it. A throw that escapes instead unwinds the whole middleware chain to
`server/http.ts`'s terminal handler and renders as a plain-text body, which is what harper#2703 reported.
`settleAuthFailure()` performs the conversion; `rejectAuthenticationInPlace()` is the only way to answer
in place, and a new principal-resolving path must route through them.

Two consequences that are easy to miss:

- **A returned 401 is invisible to a WebSocket or MQTT upgrade.** `server/REST.ts` and `server/mqtt.ts`
  only `await chainCompletion` and discard its resolved value, so an in-place decision has to be recorded
  on the request (`markAuthenticationRejectedInPlace`) for `assertNoDeferredCredentialRejection` — which
  both already call — to fail the upgrade closed. Converting a throw into a returned descriptor without
  that record turns a fail-closed upgrade into one that proceeds with no principal. The certificate
  revocation exit is the case that was missed first.
- **A deferred rejection outranks a later success.** Route owners call
  `settleDeferredCredentialRejection` _before_ they read `request.user`, so once a credential is deferred,
  resolving a principal from a different credential is a contradiction. Hence a rejected certificate
  identity stops resolution outright instead of falling through to Basic, the session, or the local bypass.

## A request's session helpers are bound module functions, never function literals assigned to a property (`security/auth.ts`)

`request.session.update` and `request.login` are `updateSession` / `loginWithSession` bound to one
per-request `SessionState`, installed after the stored session fields are copied (so a stored `update`
field is still overwritten), and they work detached or copied, as the closures they replaced did. They
must not go back to `request.login = async function …`: V8's parser pretenures a function literal assigned
to a property (`CheckAssigningFunctionLiteralToProperty`, `deps/v8/src/parsing/parser.h`), so the closure is
born in old space and keeps its young function context, and everything that context reaches (the request,
its headers, the response), alive across every scavenge until the next major GC. On a warm REST GET those
two closures promoted ~1.8 KB per request and nearly tripled major GCs. The same holds for any per-request
or per-write path: assign a function literal to a local first, or bind a module function. The helpers' behavior is covered by `unitTests/security/authSessions.test.js`.

## User and role lookups read the records, and nothing derived from them outlives them (`security/user.ts`)

Each lookup reads `hdb_user` by name and `hdb_role` by id through the primary store cache; neither operation nor replication writers need notifications to make those reads current:

- **One committed state.** RocksDB point reads share no snapshot, so `readUserEntries` re-checks the user's version after reading its role and retries if it moved; otherwise one transaction that moves a user to role B and grants role A super_user could be read as the user on A with A's new grant.
- **Derived data uses entry versions, not identity.** Uncached reads return fresh objects. The per-role memo and `isCurrentUser` compare versions, or values for `VERSION_REUSED` entries. `auth.ts` rechecks every authorization-cache hit; component-resolved users are checked against the versions captured before resolution (`trackUserRecords`).
- **Notifications are only for holders of a user.** `onUserChange` feeds live-subscription revocation and MCP list-changed from per-thread `hdb_user`/`hdb_role` subscriptions, passing the primary keys of the records changed since the last notification. No argument means which records changed is unknown — a whole-table reload, an oversized batch, a subscription re-established after a gap — and every holder rechecks. `userChangeNotificationEpoch()` is non-zero only while both subscriptions are open and the broadcaster certifies it read every record since (progress tracking, RocksDB only): a consumer that sees one non-zero epoch across a period was notified of every change in it. It never subscribes to an unaudited table, because `subscribe()` would enable and persist auditing on it; on such a node the epoch stays 0 and those consumers fall back to their own backstops.
- **A request's user is a view.** `cloneUserView(user)` permits replacing `role` and `permission` without changing the cached principal. It carries record provenance so subscription registration can detect intervening changes. An own symbol preserves provenance across spreads without a request-path `WeakMap` write; only externally resolved users use `trackedProvenance`.

LMDB lookups use the thread's shared read txn, which lmdb-js renews at most once per event-loop turn, so a commit on another thread is seen from the next turn. Resetting it per lookup would give each in-flight transaction its own reader slot. Enforced by `unitTests/security/userRecordLookups.test.js` and `unitTests/resources/replicatedUserWrites.test.js`.

### A component grant answers to its names ahead of every operations listing (`security/componentGrant.ts`)

A role's `component_deploy` grant (harper#3046) reaches `deploy_component`, `drop_component`, `get_deployment`, `list_deployments` and `get_components`, for the components its `names` patterns cover (`componentNameMatches` in `utility/componentNames.ts`, which deploy credentials share, harper#3090).

1. **The names are checked ahead of gate 2.** `verifyPerms` admits an SU-only operation the role's `operations` allowlist lists, for every component. A grant-holding role that also listed `deploy_component` would deploy anything, so the grant's check runs first and its answer is final for those five operations. Gate 1 still applies: a role with an allowlist has to list them too.
2. **The deploy and drop name is resolved as the handler resolves it** — `canonicalProjectName`, else `projectNameFromPackage` — or the check would be on a different name from the deploy. The reads name no component up front, so their handlers filter (`get_components`, `list_deployments`) or refuse (`get_deployment`, 403) by the grant themselves.
3. **The constraints hold for the entry the deploy would publish, so `deployComponent` enforces them, on the origin only.** `isolated`, `hostSuffix` and `branchedDatabases: required` are read from what the release would leave in force: a package's declared entry, a payload's owned routing, or the entry as it stands for a payload that owns none. It checks before anything is written, again under the preparation lock, and for an activation against the staged descriptor. A peer applies what the origin allowed, as it does isolation admission.
4. **A deploy credential's grant uses the same patterns, and only there.** `grant_secret component=my-app-pr-*` lets every preview's deploy resolve one dedicated credential (harper#3090, `resolveCredentials`). A component's runtime view of its secrets (`components/componentSecrets.ts`) stays exact, so preview code never reads a pattern-granted row; `harper deploy setup=true` accepts a pattern only for the github and npm providers.
5. **The key is `component_deploy`, not `components`.** Role permission keys share a namespace with database names (`RESERVED_DATABASE_NAMES`), and `components` is a plausible database name.
6. **`preview`, `maxPreviews` and `maxTtlDays` bound a preview identity**, below.

## PR previews are enabled by the cluster (`components/previewOperations.ts`)

`enable_previews`, `disable_previews` and `get_preview_policy` (harper#3042) manage the records CI authenticates as for one application's previews. The role and user are `<app>-ci-preview`, with `CI_PREVIEW_OPERATIONS`, a `component_deploy` grant for `<app>-pr-*` with `preview: required`, and no table permissions. The trust policies are `github-actions-<app>-preview` (environment `preview`) and `github-actions-<app>-preview-cleanup` (environment `preview-cleanup`, scoped to `drop_component`). The names and claims come from `utility/previewIdentity.ts`, shared with the CLI and Studio.

- **Operations, not a client composition**, unlike `harper deploy setup=true provider=github-actions` above: the CLI and Studio would each carry the names, the reconcile rules and the teardown order. The records are system-table rows, which harper-pro replicates.
- **The policy is the grant.** `maxPreviews` (for `deployment.previews.maxPerApplication`) and `maxTtlDays` sit in `component_deploy.constraints` with the other bounds, so every bound CI is held to is one replicated record, enforced on the origin. A separate `hdb_preview_policy` table would also bound a super user's deploys, but is a second record to keep in step; a super user's preview is held to the configured cap only.
- **`preview: required` binds the metadata to the grant.** A deploy under it must carry `preview` naming an app `A` whose `A-pr-*` the grant lists, as `A-pr-<n>`; otherwise it escapes expiry and the cap, and `shop-pr-pr-3` would count against `shop-pr`. It also keeps `shop`'s identity from dropping `shop-pr-tools`. `maxTtlDays` (default 7) clamps `expiresAt` before the row and the replicated request carry it; an activation past it is refused, checked against the build's row before the live-release return.
- **The cap is per origin**, as `maxPerApplication` is. It counts the origin's live previews under its lock, so two origins can each take the last slot.
- **Create-only, one at a time per node.** Enable keeps what matches and stops with a 409 on a differing record or an enabled policy giving the same runs other authority (`policiesOverlap`, `sameAuthority`). One enable or disable runs per node at a time, since two apps sharing a workflow would otherwise both pass. Each policy is rechecked just before its write (`add_oidc_trust` replaces); a writer on another node then is not excluded (#3127).
- **Disable revokes, then removes.** It drops the trust policies and deactivates the user; a deploy admitted earlier is refused at activation if the deployer's records changed (`isCurrentUser`). Its census is a barrier (#3613): `fence_preview_releases` has each node record the role's `generation` as revoked, under the per-app admission lock, then list what is live. Enable mints it into the grant and the origin stamps it on each preview deployed under it. Every stamped preview's activation, origin or peer, checks the fence in that lock, so a swap under way finishes before the node answers and a later one is refused. A grant activates only staged builds of its generation. A node that does not acknowledge counts as unreachable. A peer fences as the origin's node identity, so the fence takes harper-pro's node bypass (`isOperationAuthorizationBypassed()`); `REPLICATED_FROM` on every node operation would also lift the deploy grant. Not fenced: a super user's own preview; a pre-generation role's build in flight at disable (a `get_preview_policy` problem; rerun once `inProgress` empties); and, bounded by expiry (#3805), one a timed-out peer swaps late, crash roll-forward, a rollback or canary restore to a fenced predecessor, and the losing generation of two racing enables. Disable then drops each preview release on its node, only while it is that node's live release (`ifDeploymentId`): a drop of a release not the origin's own stops before replicating. Then it drops the user and role. A failed drop, a node that cannot say what it holds, a release with no row here yet, or one still live after a drop that removed nothing stops it, identity revoked; a rerun resumes.
- **A second policy for cleanup, not a second user.** Required reviewers on `preview` gate every job in it, so cleanup runs in `preview-cleanup` under a policy narrowed to `drop_component`, still limited by the grant to `<app>-pr-*`. Without an environment pin it would also match the deploy job's token.

## The password hash function and token lifetimes are read when used, never at module load (`security/user.ts`, `security/tokenAuthentication.ts`, `utility/password.ts`)

`harper run` on an empty root evaluates these modules (and `installer.ts`) before `install()` writes the config, and `install()` creates the admin before the startup phase (`runStartup()`) runs, so no startup hook can fix the admin's hash: `authentication.hashFunction` is resolved once per password write (`password.configuredHashFunction()`) and that same value is stored as the row's `hash_function`. Validation uses the stored value. `password.hash` defaults to the configured function; `password.validate` defaults to SHA-256 whatever is configured, because the algorithm of a stored hash is not policy and the refresh-token check validates its SHA-256 hash with that default (a config-driven default returns a Promise there, and `!Promise` accepts a superseded token). Token lifetimes are read per mint, so they need no startup hook. Enforced by `integrationTests/security/firstboot-auth-config.test.ts`.

## Local trust is a principal, not a stored user (`security/user.ts`, `security/auth.ts`)

A request trusted by its transport — `authentication.authorizeLocal` from a loopback peer (`isLocalPeerAddress`: `127.0.0.x`, `::ffff:127.0.0.x`, `::1`), the operations domain socket (`bypassLocalAuth`), a loopback MQTT connection, test mode's `bypassAuth()` — runs as `localPrincipal()`: a fixed super user named `local` that no stored record backs, so admitting it reads no record and works with no users at all.

- **Recognized by its marker, never its name.** `isLocalPrincipal` checks `_localPrincipal: true`, which only trusted code sets: `userView` copies no such field from a record, and the token, bearer-validator, OIDC and impersonation paths build users from explicit fields. A string, not a symbol, because the Bun/uWS fallback forwards `request.user` as JSON and the MQTT will row stores it. `add_user` refuses the name; a stored `local` that predates that is an ordinary user.
- **Never resolvable by name, so never portable.** Local trust belongs to the connection. A session row never names the principal (`session.update` drops it), and no token is minted for it: a credential-free `create_authentication_tokens` from it mints for the first active stored user whose role has the `super_user` flag (`getSuperUser`), or fails with 409. A by-name rehydration site checks `isLocalPrincipal` first: the MQTT will replay rebuilds the principal from the marker; live-subscription re-authorization and MCP list_changed skip it, since no record change can revoke it.
- **Each call is a separate view**, as with `userView`: fresh user, `role` and `permission` objects; the shared system-table entries and their enclosing `system` object are frozen; the table-name map stays mutable so registry updates reach held principals. The role is a default install's `super_user` role, id included, because applications authorize on `role.id` (the published redirector and early-hints templates do).

Enforced by `unitTests/security/localPrincipal.test.js` and `integrationTests/security/local-principal-token-mint.test.ts`.

## Named component children are identified by lifetime (`security/jsLoader.ts`, `security/spawnPidFile.ts`)

To prevent adopting or signaling recycled PIDs or reusing zombies ([#2968](https://github.com/HarperFast/harper/issues/2968)), a `pids/<name>.pid` record contains the positive PID, version (zero when omitted), and OS birth identity. Linux uses boot ID/PID/start ticks and excludes zombies and thread IDs; macOS uses PID/`ps lstart` in UTC/C locale (one-second resolution); Windows uses PID/`Win32_Process.CreationDate` ticks. Adoption, version replacement, wrapper kill and exit observation compare the recorded identity. A Linux record from a different boot is retired before probing its potentially inaccessible recycled PID. PID records publish through write-then-rename so readers only see a complete record; a crash before publication can still leave an unrecorded surviving child. Probe failure is unknown, never permission to retire a record or emit exit. Same-boot hidden PIDs under hidepid/ProtectProc and permission-denied probes can require operator verification/record repair or process departure; permission denial does not prove identity change. macOS/Windows wrapper probes are asynchronous and never overlap. Synchronous spawn/adoption probes run under the lock, adding serialized startup time per worker to keep the identity check fresh after lock waits. Polling is once per second on Linux/macOS and once per five seconds on Windows to bound recurring PowerShell cost; exit notification can lag by that interval plus probe time. A signal-zero fast path with infrequent birth checks was rejected because a reused live PID would keep an exited wrapper open until that longer check interval. Legacy records are retired without signaling their unverified PID, with a warning: a surviving legacy child may coexist with the replacement once during upgrade. Older builds ignore the third line, so mixed-version access does not gain this safety guarantee.

Synchronous spawning uses a filesystem bakery lock: contenders atomically publish choosing/ticket states at their own UUID filenames; stale removal targets only that UUID. Ticket ordering is shared with `componentPreparationLock.ts`. Only successfully matching foreign owner identities are cached, for one second; a stale positive can delay reclamation but cannot authorize reclaiming a live claim. PID record and claim operations retry transient Windows sharing errors. An owner whose claim cannot be unlinked publishes a unique release marker; scans honor the marker before reading the retired claim and clean up both when possible. Acquisition, publication and conditional exit cleanup use the same claim protocol, preventing a stale checker or an older child's exit from removing a newer record. Waits sleep for 50 ms with `Atomics.wait` and fail after 60 seconds without queue progress, renewing only as the original predecessor cohort assigns tickets or retires; later arrivals cannot renew a stalled wait; they never steal from a live process. External identity probes have a 30-second deadline. Exit cleanup makes one non-waiting attempt using the cached own identity and conservatively live foreign claims, without launching identity probes; a busy record is left for the next verified spawn to retire. Metadata file operations retain their bounded retries. Release failures are reported separately so they do not replace the spawn result or native error; if both claim removal and marker publication fail, operator repair/restart is still required. A claim abandoned by a terminated worker while Harper still lives can block until Harper restarts; OS identity cannot establish worker-thread liveness synchronously. A main-thread exit sweep is feasible for managed workers, but adding thread identities and another lifecycle cleanup path is deferred: constrained spawning also runs in standalone workers and main-thread scopes without that manager. This protocol keeps conservative process-lifetime reclamation as the common fallback. Unreadable owners also fail rather than permit concurrent spawning. Native PID handles would be required to eliminate the remaining identity-check-to-signal race and OS timestamp-resolution limits. The spawning thread cannot reap its fresh child while synchronous identity capture is running, so no wall-clock spawn bound is needed. Enforced by `unitTests/components/spawnPidIdentity.test.js`, `unitTests/components/spawnPidFile.test.js` (both unit suites are Windows-gated), and `integrationTests/components/named-process.test.ts`.

Version replacement signals the verified PID through `process.kill(pid)`. Node reports PID-based termination on Windows through the original `ChildProcess.exitCode`, leaving `signalCode` null.

Named-process probe and lock failures use `NamedProcessError`, a `ServerError` subtype with the original cause; native child-process argument errors retain their original class and code.

## Application lockdown seals the intrinsics by default (`security/intrinsicsLockdown.ts`)

`applications.lockdown` defaults to `seal-after-load` on fresh installs; the installer writes the whole config, so upgrades keep their prior mode. Sealing blocks additions/deletions on 21 intrinsic globals and prototypes plus `Function`/`Function.prototype`, while allowing overwrites; it is not a sandbox. Never make seal-mode prototype properties read-only: array-hole stores become ~45× slower and msgpackr decode ~3× slower; accessors prevent built-in inlining. Only freeze modes need `overridableProperty`. Sealing covers replaced globals and realm originals, which literals/async functions retain; freezing covers current globals, leaving `Function.prototype` extensible. Unknown truthy modes freeze eagerly (fail closed); falsy modes skip lockdown. Tests: `unitTests/security/intrinsicsLockdown.test.js` (fresh workers), `integrationTests/components/intrinsics-lockdown.test.ts`; measurements: `benchmarks/lockdown/run.mts`.

## A scoped mirror is never advertised before its allowlist is read (`security/networkAccess.ts`)

`system.hdb_network_access` holds one replicated row per scope (`operations` today). A fronting proxy enforces it; Harper only publishes it as `allowedSources` in the UDS mirror metadata (`writeUdsMetadata`, `server/http.ts`).

- **No unrestricted advertisement.** The writer, not `ready`, holds a scoped mirror until this thread's first successful read, because `security/keys.ts` fires `secureContextsListeners` before readiness. A table absent after databases load means unrestricted.
- **One reconciler per scope.** Subscription events, the 60 s tick and `onUpdatedTable` only trigger one serialized `table.get(scope)`; payloads are ignored, so a missed event converges on the next read. A failed write is retried by the tick.
- **Lockout check.** `set_network_access` refuses a list excluding the caller's address, carried by `runWithCallerAddress`, never on the operation body. Only Node's operations domain socket (the recovery path) skips it; any other unknown address needs `force`. Matching unmaps `::ffff:a.b.c.d` first, as the proxy does. Peers reached through the proxy must be listed too; Harper cannot see their addresses, so it only warns.

## Resource attribute permissions

`getTablePermissions` adds the unlisted key’s `implicitPrimaryKeyPermission`; operations translation drops listed undeclared properties. Explicit key denials, timestamps and sealed membership apply. `updatedAttributes` resets the permission memo.

`allowUpdate` retains `allowTableUpdate`’s map through puts/locks until its next call. Payloads omit protected values. `restrictedReplacement` patches full puts: omitted writable keys remain own `undefined` properties (JavaScript/MessagePack see them; JSON omits them). This avoids stale protected bases. Restricted source writes use implemented `patch` or materialized `put`. PATCH limits remain: delete/retry can create partial rows, put-only sources with cold/stale caches can lose protected values, and `__op__` values are operations. Invalid full roots are refused. Trusted direct PATCH/create thenables can check resolved keys but store original fields. Dispatch resolves bodies; helpers reject failed promises without override re-entry. Tests: `unitTests/resources/permissions.test.js`, `unitTests/server/preconditions.test.js`, `integrationTests/security/resource-attribute-permissions.test.ts`. Gaps: commit-time retry, crash replay and replication apply.

## System permissions on roles

`permission.system` derives from `super_user` and the registry. Held identities share mutable maps with frozen entries. API declarations return 400; files strip and warn on changed contents, not replay. Legacy copies strip without writes that could race `alter_role`; warnings dedupe by revision/thread. Impersonation reinstalls managed maps; scoped tokens strip before hashing to avoid MCP churn. External response reuse is per-call; listeners are lazy to avoid the Resource import cycle.
