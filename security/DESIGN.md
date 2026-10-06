# security/ — Design notes

Authentication tokens, OIDC exchange and TLS material.

**Read this when:** touching `tokenAuthentication.ts`, `impersonation.ts`, `authn/oidc/`, `keys.ts` or `certificateVerification/`.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## OIDC trusted publishing (`security/authn/oidc/`)

`exchange_oidc_token` lets a workload authenticate with no stored Harper credential (#2171): it presents an identity token minted by its runtime, and gets back a one-hour operation token for the user a stored trust policy names. It is in `NO_AUTH_OPERATIONS` because it _is_ the authentication, the same way `create_authentication_tokens` is against a password — the same three wiring points apply (`serverHandlers.js` `NO_AUTH_OPERATIONS`, the `verifyPerms` bypass in `serverUtilities.ts`, and a `permission(false, [], OPERATIONS_ENUM.EXCHANGE_OIDC_TOKEN)` registration).

**The core is issuer-agnostic; everything issuer-specific lives in `providers/`.** That split is the point of the layout, not an accident of it — a new workload-identity issuer should be a profile, not a change to verification, matching, or storage.

- `claims.ts` — matching and constraint _shape_ validation. Knows nothing about any issuer.
- `jwks.ts` — issuer keys. The rate-limit clock for unknown-`kid` refetches lives _outside_ the cache entry: a successful fetch replaces the entry, and a rate limit that resets whenever it fires is not a rate limit. Keeping it separate also means a genuine key rotation is picked up on first use rather than after the window.
- `identityToken.ts` — signature, issuer, audience, `exp`, and a bounded lifetime. Owns `rejectToken`, shared with the exchange so both halves refuse identically.
- `tokenExchange.ts` — policy selection, replay, minting, audit. Verification is memoized per audience, so N policies sharing one cost one signature check.
- `providers/` — `assertPolicyIsSpecific` / `assertAudienceIsSpecific` / `normalizeClaims` / `describePrincipal` / optional `vetoClaims`, resolved by normalized issuer.

**An unregistered issuer gets `providers/generic.ts`, which is strict rather than permissive:** the policy must pin `sub`. That is what makes Kubernetes service accounts, GCP service accounts, and SPIFFE SVIDs work with zero provider code — each has a stable canonical subject. GitHub needs its own profile precisely because its `sub` is the one claim you should _not_ pin: it varies by trigger, and its format changed for repositories created after 2026-07-15.

Four constraints that look like choices but are not:

1. **Every rejection returns the same message.** The endpoint is unauthenticated; a caller told which check failed can enumerate a policy one claim at a time. Reasons go to the `oidc-trust` logger.
2. **A GitHub policy must gate the ref.** `githubActionsProfile.assertPolicyIsSpecific` rejects a policy pinning only repository + workflow, because anyone who can push a branch could then add that workflow to it and mint a token. Stricter than npm's trusted-publishing model, which mitigates the same hole with environment protection instead — and profile-scoped, so it never constrains another issuer.
3. **`createOperationToken`, not `createTokens`.** `createTokens` overwrites `hdb_user.refresh_token` as a side effect, so minting for CI would silently revoke whatever credential that user already held (#2018) — the exact problem this feature removes.
4. **The role is the boundary; the per-policy `operations` allowlist only narrows it.** Least privilege is primarily the role of the user the policy names. A policy may _optionally_ carry an `operations` scope, which can only subtract from that role — never add to it. It is deliberately not merged into `permission.operations`: gate 2 in `operation_authorization.ts` treats an explicit listing of an SU-only operation as a deliberate grant, so reusing that field would _widen_ where this must only narrow. The scope is carried as a separate `tokenOperations` claim and intersected ahead of every early return, including the super_user bypass.

   Its enforcement surface is the operations API and SQL (`verifyPerms` / `verifyPermsAST`) — **not** the application REST/GraphQL resource path, which authorizes through table-level `checkPermission` and does not consult the scope. A scoped token therefore still carries its role's full CRUD there, which is why the role has to be least-privilege on its own; the scope is defense in depth, not a substitute. Closing that gap is tracked in #2201. The scope shipped with #2173 and is documented in the operations API reference; whether to keep a second authorization mechanism beside roles at all — one more place for the two to disagree — was left open there.

   Naming `sql` in a scope grants the SQL interface, not unrestricted DML through it: a write statement additionally requires its matching data operation (`insert`/`update`/`delete`) in scope. That is what keeps `read_only` — which expands to include `sql` — from admitting a DELETE, given that `verifyPermsAST` returns early for a super_user before any table check runs.

`hdb_oidc_token_use` (declared on every node at every start by `tokenUseTable.ts`, so a node that never exchanges still removes the rows replicated to it — see dataLayer/DESIGN.md, "System table bootstrap") records spent tokens keyed on a SHA-256 of the token itself, each expiring (record metadata, replicated with the row) past the token's own expiry. Hashed rather than stored, so the table never holds a credential; keyed on the token's **signed input** (`header.payload`) rather than `jti` because not every issuer emits one (Azure uses `uti`). Not on the whole token string: the signature segment is covered by nothing, and base64url decoding ignores the surplus low bits of its final character, so 16 distinct spellings of an RS256 signature decode to the same bytes, all verify, and all hash differently — one leaked token would buy 16 exchanges. ES\* malleability (`s → n−s`) is a second such vector. The signed input is exactly what the issuer asserted, so every variant collapses to one fingerprint. The get-then-put is not atomic and does not claim to be: a concurrent replay is not a privilege escalation, since whoever holds the token could obtain one operation token anyway.

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
`hdb_user._scopedToken` requester. **Any future by-name rehydration must check `_scopedToken`.** A
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
`applyImpersonation` re-keys all three impersonation modes the same way (Mode B/C previously wrote
downgraded copies under the _persisted_ role's name). Synthetic translations live in a separate
256-entry LRU (`syntheticRolePermsMap`), not the permanent `rolePermsMap` — so >256 concurrently
live distinct permission sets degrade to per-request translation (a deliberate cliff; raise the
constant if a legitimate workload hits it). The `_` name prefix is the discriminator; a persisted
role named with a leading underscore lands in the LRU too (correct, just evictable). Relatedly,
the role `operations` allowlist gate in `verifyPerms` must stay **ahead of** the ambient privilege
early-returns (super_user, structure_user, system-table allowances): persisted roles can't combine
`super_user` with other permission keys, but inline roles can combine `structure_user` with an
allowlist, and the gate ordering is what keeps unlisted schema ops unreachable.

## TLS hot-reload publishes matching configured pairs (`security/keys.ts`)

`loadCertificates` publishes a configured leaf only after `X509Certificate.checkPrivateKey` validates the exact PEM being stored. Only the main thread watches the certificate and key directories; its filename-filtered, shallow watches and five-minute safety poll share a cert/key fingerprint. An incomplete pair returns `false` so it is retried, with a pending-pair warning and an error after 30 seconds (immediate when the new certificate name has no non-self-signed record, then hourly). Restoring the last applied files after an aborted renewal re-enters the loader to clear the pending alarm. Every raw watcher event also arms one trailing check, at most once a second and never postponed, that loads a fingerprint not yet attempted (only the optional poll retries an unchanged unapplied pair): chokidar stops emitting add/change for a name removed twice within its 100 ms removal throttle (it keeps tracking the deleted inode), so its derived events cannot be the only trigger; events the OS never delivers are still left to the optional poll. CA-only records remain independent of the leaf key. Workers use the `hdb_certificate` subscription as their reload trigger and read configured key files when building contexts; no worker key watcher or poll races that notification. Configured keys remain in `getPrivateKeys()` for key retrieval, but entries populated from files are refreshed for retrieval and rebuilds, retaining their cached value while the file is temporarily unreadable; explicit values that differ from the last file-derived key still take precedence. A directory that cannot be watched because it is not readable falls back to Node file polling, which remains armed while configured files are absent, independently of the optional five-minute safety poll. Enforced by the rename-order, per-worker, poll-disabled cases in `integrationTests/security/cert-key-reload.test.ts` and loader tests in `unitTests/security/keys.test.js` and `unitTests/security/tlsFileWatch.test.js`.

An unrelated table notification during a key-first installation gap, or a second rotation between publication and a worker's key read, can still produce a transient mismatch; the trust-aware last-good retention below protects serving while the next complete pair propagates. The older-file guard still prevents disk from replacing a newer replicated certificate.

**Publication is transactional (#2382).** `updateTLS` builds the entire replacement state —
hostname→context map, CA map, and default candidate — into pass-local candidates and reconciles the
live maps in place only after the pass completes (their identity is load-bearing:
`server.secureContexts` and each context's `availableCAs` alias them). A record that is still in the
table but fails to build (`ERR_OSSL_X509_KEY_VALUES_MISMATCH` when the table's cert outruns the
on-disk key, a missing key on this thread) keeps every live entry it owns _and_ its default
candidacy — a record can be serving as the default with no hostname entries at all — so a transient
mismatch never downgrades serving below last-good (the pre-fix behavior served the self-signed
default for days). Retention is trust-aware: a context froze its `ca:` list at build time, so when
the CA set has changed since, the retained pair is rebuilt against the current trust material —
new handshakes never see revoked client-CA trust; established sessions and outstanding session
tickets are unaffected, exactly as on a fresh build (ticket keys are process-wide and never rotate
on trust changes) — and if that rebuild fails the record's entries
drop for that pass, except when nothing else is servable: the zero-certificate guard then retains
the old state (availability outranks the drop in that corner) while the failure keeps retrying. Deleting the record remains the way to drop its contexts; a corrupt authority
row is a pass failure like any other (reported through the signature throttle, armed for retry) and
its trust drops until it heals. A failed pass arms a
self-retry on the shared debounce with a per-signature backoff (1.5s doubling to 5min) and
signature-throttled logging; external triggers (table subscription) stay at the plain
debounce. `loadAndWatch` latches its cert/key fingerprint before the callback for chokidar/poll dedupe, but rolls
the latch back on a false result, synchronous throw, or rejected callback promise (equality-guarded so a stale
rejection cannot unlatch a newer reload) — the latch means "last successfully applied", so the
periodic poll can heal a lost `hdb_certificate` write instead of deduplicating it forever.

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
`The requested module 'harper' does not provide an export named 'x'`. Enforced by
`unitTests/security/harperModuleExports.test.js`: every package value export must reach a compartment
unless it is on that test's package-only list, and the helpers a protocol plugin needs for parity with
the MQTT endpoint (harper#2715) must be the identical function on both paths. The lists stay separate on
purpose: the compartment binds `server`/`logger`/`resources`/`config`/`secrets` and the branched
`databases`/`tables`/`defineTable` per scope, and omits what only harper-pro consumes through `core/`.

Export the value from the module that _defines_ it rather than re-exporting it through an intermediate,
so a component-created value shares that module's private symbols. `markCredentialRejection` depends on
this: its tag is a module-private `Symbol` that `isCredentialRejection` checks by identity.

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

## User and role lookups read the records, and nothing derived from them outlives them (`security/user.ts`)

There is no per-thread copy of `hdb_user`/`hdb_role`: every lookup point-reads the user by name and its role by id through the primary store's record cache, so no writer (an operation, a replicated commit) has to announce a change for lookups to see it. Three rules keep that true:

- **One committed state.** RocksDB point reads share no snapshot, so `readUserEntries` re-checks the user's version after reading its role and retries if it moved; otherwise one transaction that moves a user to role B and grants role A super_user could be read as the user on A with A's new grant.
- **Derived data is keyed by entry version, not object identity.** With `storage.caching: false` every read returns a new object. The per-role memo of `appendSystemTablesToRole` + expanded operations, and `isCurrentUser`, compare versions; a `VERSION_REUSED` entry is compared by value instead, since its version no longer identifies one value. `auth.ts` runs `isCurrentUser` on every `authorizationCache` hit, so a cached principal is re-verified once its user or role record changes; a component's `server.getUser` principal is checked against the versions read for its name before it was resolved (`trackUserRecords`).
- **Notifications are only for holders of a user.** `onUserChange` feeds live-subscription revocation and MCP list-changed from per-thread `hdb_user`/`hdb_role` subscriptions. It never subscribes to an unaudited table, because `subscribe()` would enable and persist auditing on it; on such a node those consumers fall back to their own backstops.

LMDB lookups use the thread's shared read txn, which lmdb-js renews at most once per event-loop turn, so a commit on another thread is seen from the next turn. Resetting it per lookup would give each in-flight transaction its own reader slot. Enforced by `unitTests/security/userRecordLookups.test.js` and `unitTests/resources/replicatedUserWrites.test.js`.

## Named component children are identified by lifetime (`security/jsLoader.ts`, `security/spawnPidFile.ts`)

To prevent adopting or signaling recycled PIDs or reusing zombies ([#2968](https://github.com/HarperFast/harper/issues/2968)), a `pids/<name>.pid` record contains the positive PID, version (zero when omitted), and OS birth identity. Linux uses boot ID/PID/start ticks and excludes zombies and thread IDs; macOS uses PID/`ps lstart` in UTC/C locale (one-second resolution); Windows uses PID/`Win32_Process.CreationDate` ticks. Adoption, version replacement, wrapper kill and exit observation compare the recorded identity. A Linux record from a different boot is retired before probing its potentially inaccessible recycled PID. PID records publish through write-then-rename so readers only see a complete record; a crash before publication can still leave an unrecorded surviving child. Probe failure is unknown, never permission to retire a record or emit exit. Same-boot hidden PIDs under hidepid/ProtectProc and permission-denied probes can require operator verification/record repair or process departure; permission denial does not prove identity change. macOS/Windows wrapper probes are asynchronous and never overlap. Synchronous spawn/adoption probes run under the lock, adding serialized startup time per worker to keep the identity check fresh after lock waits. Polling is once per second on Linux/macOS and once per five seconds on Windows to bound recurring PowerShell cost; exit notification can lag by that interval plus probe time. A signal-zero fast path with infrequent birth checks was rejected because a reused live PID would keep an exited wrapper open until that longer check interval. Legacy records are retired without signaling their unverified PID, with a warning: a surviving legacy child may coexist with the replacement once during upgrade. Older builds ignore the third line, so mixed-version access does not gain this safety guarantee.

Synchronous spawning uses a filesystem bakery lock: contenders atomically publish choosing/ticket states at their own UUID filenames; stale removal targets only that UUID. Ticket ordering is shared with `componentPreparationLock.ts`. Only successfully matching foreign owner identities are cached, for one second; a stale positive can delay reclamation but cannot authorize reclaiming a live claim. PID record and claim operations retry transient Windows sharing errors. An owner whose claim cannot be unlinked publishes a unique release marker; scans honor the marker before reading the retired claim and clean up both when possible. Acquisition, publication and conditional exit cleanup use the same claim protocol, preventing a stale checker or an older child's exit from removing a newer record. Waits sleep for 50 ms with `Atomics.wait` and fail after 60 seconds without queue progress, renewing only as the original predecessor cohort assigns tickets or retires; later arrivals cannot renew a stalled wait; they never steal from a live process. External identity probes have a 30-second deadline. Exit cleanup makes one non-waiting attempt using the cached own identity and conservatively live foreign claims, without launching identity probes; a busy record is left for the next verified spawn to retire. Metadata file operations retain their bounded retries. Release failures are reported separately so they do not replace the spawn result or native error; if both claim removal and marker publication fail, operator repair/restart is still required. A claim abandoned by a terminated worker while Harper still lives can block until Harper restarts; OS identity cannot establish worker-thread liveness synchronously. A main-thread exit sweep is feasible for managed workers, but adding thread identities and another lifecycle cleanup path is deferred: constrained spawning also runs in standalone workers and main-thread scopes without that manager. This protocol keeps conservative process-lifetime reclamation as the common fallback. Unreadable owners also fail rather than permit concurrent spawning. Native PID handles would be required to eliminate the remaining identity-check-to-signal race and OS timestamp-resolution limits. The spawning thread cannot reap its fresh child while synchronous identity capture is running, so no wall-clock spawn bound is needed. Enforced by `unitTests/components/spawnPidIdentity.test.js`, `unitTests/components/spawnPidFile.test.js` (both unit suites are Windows-gated), and `integrationTests/components/named-process.test.ts`.

Version replacement signals the verified PID through `process.kill(pid)`. Node reports PID-based termination on Windows through the original `ChildProcess.exitCode`, leaving `signalCode` null.

Named-process probe and lock failures use `NamedProcessError`, a `ServerError` subtype with the original cause; native child-process argument errors retain their original class and code.
