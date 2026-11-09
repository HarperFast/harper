# security/ — Design notes

Authentication tokens, OIDC exchange and TLS material.

**Read this when:** touching `tokenAuthentication.ts`, `impersonation.ts`, `authn/oidc/`, `keys.ts`, `certificateVerification/` or role attribute permissions.

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## OIDC trusted publishing (`security/authn/oidc/`)

`exchange_oidc_token` trades a workload identity token for a one-hour operation token for the user a trust policy names (#2171). As authentication, it is in `NO_AUTH_OPERATIONS` (`server/serverHelpers/serverHandlers.ts`), bypasses `verifyPerms` (`serverUtilities.ts`) and registers `permission(false, [], OPERATIONS_ENUM.EXCHANGE_OIDC_TOKEN)`.

**The core is issuer-agnostic; everything issuer-specific lives in `providers/`.** A new issuer is a profile, not a core change.

- `jwks.ts` — the unknown-`kid` refetch rate limit lives outside the cache entry a successful fetch replaces.
- `identityToken.ts` — signature, issuer, audience, `exp`, bounded lifetime; owns `rejectToken`, shared with `tokenExchange.ts` so both refuse identically. `tokenExchange.ts` memoizes verification per audience, so N policies sharing one cost one signature check.
- `providers/` — `assertPolicyIsSpecific` / `assertAudienceIsSpecific` / `normalizeClaims` / `describePrincipal` / optional `vetoClaims`, by normalized issuer.

**An unregistered issuer gets the strict `providers/generic.ts`:** the policy must pin `sub`. GitHub's `sub` varies by trigger and must _not_ be pinned, hence its own profile.

Fixed constraints:

1. **Every rejection returns the same message**, so an unauthenticated caller cannot enumerate a policy; reasons go to the `oidc-trust` logger.
2. **A GitHub policy must gate the ref.** `githubActionsProfile.assertPolicyIsSpecific` rejects pinning only repository + workflow, since any branch pusher could add that workflow and mint a token.
3. **`createOperationToken`, not `createTokens`**, which overwrites `hdb_user.refresh_token`, revoking the user's credential (#2018).
4. **The role is the boundary; the per-policy `operations` allowlist only narrows it.** It is a separate `tokenOperations` claim (#2173), not `permission.operations` (gate 2 in `operation_authorization.ts` grants a listed SU-only operation), intersected before every early return, including super_user's. Only the operations API and SQL (`verifyPerms` / `verifyPermsAST`) enforce it, not REST/GraphQL (`checkPermission`), so the role must itself be least-privilege (#2201). Naming `sql` grants the interface, not DML: writes also need `insert`/`update`/`delete`, so `read_only` (which includes `sql`) admits no DELETE despite `verifyPermsAST`'s super_user early return.
5. **Policy ids never choose authority.** A token two enabled policies map to different users or operations is refused unspent (no write can exclude such a pair across nodes); agreeing policies use the first by id.

`hdb_oidc_token_use` keys spent tokens on a SHA-256 of the **signed input** (`header.payload`): no stored credential, no reliance on `jti`, and no malleable signature spelling. Rows expire (replicated record metadata) after the token does; `tokenUseTable.ts` declares the table on every node at every start, so each removes replicated rows (dataLayer/DESIGN.md, "System table bootstrap"). The get-then-put is not atomic; a concurrent replay is no escalation.

**The minted token carries where the run came from:** a signed `deploy_source` claim (`attestedSource`, `components/deploymentSource.ts`), lifted by `validateToken` to `deploySource`, kept through impersonation, and recorded by `deploy_component` as attested over what the request declares (#3061). Signed, so a caller cannot edit it; claims, not the token, so the row holds no credential.

`harper deploy setup=true provider=github-actions` (`bin/deploySetupGithubActions.ts`) creates role and user `<component>-ci-deploy` and policy `github-actions-<component>`, names Studio's setup must match. A differing or deactivated record stops it before any write, so it never repurposes a role or undoes a revocation. `add_oidc_trust` replaces, so setup re-lists the policy just before writing (one created meanwhile is still overwritten), then reads it back claim for claim, since a mismatch otherwise surfaces only as an opaque 401. A server-side create-only check would not close the race: `hdb_oidc_trust` replicates, so it would be per node.

## Scoped tokens and synthetic-role identity (`security/tokenAuthentication.ts`, `security/impersonation.ts`)

`create_authentication_tokens` with an inline `role` **object** mints a `sub: 'scoped-operation'` JWT embedding its (downgraded, deep-validated) permissions, needing no `hdb_user`/`hdb_role` row; `username` is only attribution. Minting is super_user-gated (or `isOperationAuthorizationBypassed()`); a string `role` keeps its legacy meaning (`validateOperationToken` rejects it). With no refresh token, scoped tokens are **irrevocable until expiry**, so `auth.ts` evicts cached Bearer identities at exact `authExpiresAt`.

`username` must NOT name an existing `hdb_user` (rejected at mint; default `scoped:<minter>`), or by-name rehydration would substitute that user's permissions. By-name sites short-circuit on `_scopedToken`: MQTT last wills (`DurableSubscriptionsSession.ts`, never published past `authExpiresAt`), `Resource.ts` `registerLiveSubscriptionForContext`, `components/mcp/listChanged.ts` `refreshSessionUser`, and passwordless `createTokens` (rejected). **Any future by-name rehydration must check `_scopedToken`** (and `isLocalPrincipal`, below).

The `operations` allowlist gates only the **operations API** (`sql` calls `verifyOperationsAllowlist` from `chooseOperation`); REST/GraphQL/MQTT use table CRUD permissions, so `operations: ['read_only']` does not stop REST writes.

Gate 1 in `verifyPerms` checks the registered `api_name`, not the handler's; only unregistered `sql` is checked as given. `permission` requires that name (a compile error to omit) or `null` when no allowlist may grant the operation. An alias grants nothing; its canonical name grants both spellings. `get_backup`, `read_transaction_log` and `catchup` are `null`: gate 2 would grant `get_backup` before its READ check, `read_transaction_log` lacks `read_audit_log`'s `system.hdb_secret` guard, and `catchup` writes any table unchecked. `unitTests/utility/operation_authorization.test.js` holds every dispatched operation to this.

`permissionsTranslator.getRolePermissions` memoizes **by role name** (then `__updatedtime__` + schema), so a synthetic (inline/impersonated/scoped) role must never carry a constant name or per-request timestamp, or two permission sets share a slot and leak. `syntheticRoleName()` hashes the post-downgrade permissions with `__updatedtime__: 0`, as `applyImpersonation` does for all three modes; `_`-prefixed names (persisted too) use the 256-entry LRU `syntheticRolePermsMap`, so more than 256 live permission sets degrade to per-request translation (a deliberate cliff; raise the constant if a workload hits it). The allowlist gate in `verifyPerms` must stay **ahead of** the super_user, structure_user and system-table early returns, since an inline role can pair `structure_user` with an allowlist.

## TLS hot-reload publishes matching configured pairs (`security/keys.ts`)

`loadCertificates` publishes a configured leaf only once `X509Certificate.checkPrivateKey` validates the stored PEM (CA-only records ignore the key); an incomplete pair returns `false`, retries, then alarms; restoring the last applied files after an aborted renewal clears the alarm. Config entries sharing one certificate file can leave a record's `uses`/`ciphers` differing from the load-time owner's until restart. Only the main thread watches, sharing a cert/key fingerprint with the five-minute poll; each raw watcher event arms a trailing check, since chokidar drops add/change for a name removed twice within 100 ms, and an unreadable directory falls back to Node file polling. Workers reload on the `hdb_certificate` subscription, reading key files when building contexts. File-populated `getPrivateKeys()` entries refresh, surviving an unreadable file; a differing explicit value wins.

The older-file guard keeps disk from replacing a newer replicated certificate and freezes `hostnames` and `private_key_name`, not `ciphers`/`uses`: at load, config edits to those patch a PEM-matching record the loader marked `from_config: true` (a removed `ciphers` becomes `null`). `file_timestamp` cannot mark ownership, as API patches keep it; `setCertTable` nulls the marker when a write sets `ciphers` or `uses`, so API values persist. A pre-marker record is adopted only if it already matches config; others that differ are logged. Changes apply at start or file change, not `restart_service`.

**Publication is transactional (#2382).** `updateTLS` builds the hostname→context map, CA map and default candidate pass-locally, then reconciles the live maps in place: `server.secureContexts` and each context's `availableCAs` alias them. A table record that fails to build keeps its live entries _and_ default candidacy (last-good through a transient mismatch), rebuilt against current trust if the CA set changed (established sessions and ticket keys are unaffected); if that fails it drops for the pass unless the zero-certificate guard must keep it. A corrupt authority row fails the pass and drops its trust. Deleting the record drops its contexts. A failed pass retries with per-signature backoff (1.5 s doubling to 5 min); the table subscription keeps the plain debounce. `loadAndWatch` rolls its fingerprint latch back on any failure, so the poll heals a lost `hdb_certificate` write.

**Passes run as the system (harper-pro#1189).** `initialize()` can first run inside a request, so `updateTLS` re-enters under `contextStorage.exit()` (via `run(undefined, …)`; native `exit()` leaks, see `resources/DESIGN.md`); otherwise `hdb_certificate` calls would consume the request's one-shot `authorize` and timers would keep its context. A pass failing before `.ready` settles rejects it, but a live selector keeps retrying (a listener calls `initialize()` once) until recovery or a later `initialize()` replaces it; a one-shot selector's attempt retires at once. Until then `.ready` stays rejected, as the Bun listener would read `undefined` as "no TLS".

Tests: `integrationTests/security/cert-key-reload.test.ts`, `unitTests/security/tlsFileWatch.test.js`, `unitTests/security/keys.test.js` (incl. `ciphers and uses follow config`, `createTLSSelector initialized by a request`).

## Self-signed renewal replaces the pair in one transaction (`security/keys.ts`)

`publishSelfSignedCerts` writes what `prepareSelfSignedCerts` builds, and on `renewSelfSigned` deletes the old self-signed rows, in one `transaction()`: `setCertTable` patches by name and the CA name repeats when `node.hostname` is set, so a split renewal could replace the CA but not the leaf. Renewal reuses only non-self-signed CA and replication rows (`getCertAuthority(true)`, `getReplicationCert(true)`), or a self-signed `replication` leaf would outscore an external generic one. Publication re-reads each row in the transaction and never replaces or deletes a non-self-signed one: renewal fails, and boot review warns and skips it (and the leaf, for the CA). If an external row holds the node name, the leaf is `<node>-self-signed`; selection is by hostname. A same-key write within the commit window is uncovered. A configured key path names the CA key only if it parsed; a generated key is created exclusively (`wx`, `0o600`) in `keys/` after the records are built and removed if publication fails. Enforced in `unitTests/security/keys.test.js` and `integrationTests/security/renew-certs-missing-privatekey.test.ts`.

## Client-certificate revocation checking keeps three tables (`security/certificateVerification/`)

`verificationTables.ts` declares them; every writable start and the verification path apply them (dataLayer/DESIGN.md, "System table bootstrap"). Row expiry is record metadata; a table's `expiration` is only a fallback.

- A verdict (`hdb_certificate_cache`) expires `cacheTtl` after its check because `CertificateVerificationSource` sets `context.expiresAt`; a fill stores `sourceContext.expiresAt`, not a returned field. `createCacheKey` hashes a key version, so older expiry-less verdicts are never read.
- A revocation (`hdb_revoked_certificates`) lives until `crl_next_update + gracePeriod`, the window `performCRLCheck` honors, or an overdue CRL would pass a revoked certificate.
- A CRL's revocations replace the previous set all or nothing in their own transaction, not the verdict fill's. The downloading check decides from the CRL itself, as another worker may have replaced the set. A cached-CRL check reads the table outside the verdict fill's transaction, whose LMDB snapshot misses later commits.

## A component-facing export needs BOTH `index.ts` and `getHarperExports` (`security/jsLoader.ts`, `index.ts`)

A VM-compartment component's `harper` is a synthetic module from the hand-maintained `getHarperExports()`, not `index.ts`, so a value in only one fails at load. Only a fixture importing `'harper'` catches it (`integrationTests/security/fixtures/deferred-credential-rejection/resources.js`, harper#2703).

Export from the defining module, not a re-export, so components share its private symbols: `isCredentialRejection` checks `markCredentialRejection`'s `Symbol` tag by identity.

## Both application loaders resolve through one `resolveModule` (`security/jsLoader.ts`)

The VM loader and the compartment `resolveHook` share `resolveModule`, which is CommonJS-first: only an import of a bare specifier the CommonJS resolver rejects (`ERR_PACKAGE_PATH_NOT_EXPORTED`; `MODULE_NOT_FOUND` on Bun) falls back to a port of Node's `PACKAGE_EXPORTS_RESOLVE` with the `node`, `import` and (on Bun) `bun` conditions, checked by the `resolves package exports as native Node import does` cases. Node's `module-sync`, `node-addons` and `--conditions` are not modeled. A `require()` never falls back. A fallback records `package.json` and entry-file digests, not an edge `RuntimeModuleTracker` would re-resolve with `createRequire` and see as changed every deploy.

SES loads through `loadSES` from ESM shims, never `require('ses')` (its CommonJS bundle fails `SES_NO_SLOPPY` on Bun), and lockdown shares that instance. Tests: the `pure-ESM package resolution` blocks in `unitTests/security/jsLoader/jsLoader.test.js` and `integrationTests/components/compartment-pure-esm-dependency.test.ts`.

## `require()` and `import` pass the same gates in the VM loader (`security/jsLoader.ts`)

In `vm` and `vm-current-context` modes every entry point (`linker`, both `importModuleDynamically` hooks, `cjsRequire`) applies, in order, the `'harper'` alias, `checkAllowedModulePath` and its substitute, the `shouldUseApplicationLoader` app-vs-native decision, and for app-loaded files `readApplicationModule`; a new entry point or branch owes all four. Only a compile error of a module's own CommonJS wrapper selects the ESM retry in `createModuleFromSource`.

URL-keyed `cjsCache` and `nativeModules` (registered before native evaluation, released on failure) serve both forms, so a file keeps its first route and one instance per scope; both hold only checked modules. Not covered: compartment mode's `importHook`, native packages' own requires, JSON imports, and a bare `require()` of app-loaded ESM under `dependencyLoader: native` (Node's `require(esm)` instance). Tests: the `CommonJS require` blocks in `unitTests/security/jsLoader/jsLoader.test.js` and `integrationTests/components/cjs-require-loader.test.ts`.

## Authentication converts every principal-resolution failure into a decision (`security/auth.ts`)

`authentication()` resolves a principal (certificate CN, `Authorization` header, `hdb_session` cookie) via the overridable `server.getUser`; every failure becomes a **decision** through `settleAuthFailure()`, never a throw to `server/http.ts`'s plain-text terminal handler (harper#2703). Internal faults and the operations API answer in place, only via `rejectAuthenticationInPlace()`; tagged credential rejections defer to the route's owner.

- **A returned 401 is invisible to a WebSocket or MQTT upgrade.** `server/REST.ts` and `server/mqtt.ts` discard `chainCompletion`'s value, so every in-place decision must call `markAuthenticationRejectedInPlace`, or `assertNoDeferredCredentialRejection` lets the upgrade proceed unauthenticated.
- **A deferred rejection outranks a later success.** Route owners call `settleDeferredCredentialRejection` before reading `request.user`, so a rejected certificate identity stops resolution rather than fall through to Basic, the session or the local bypass.

## A request's session helpers are bound module functions, never function literals assigned to a property (`security/auth.ts`)

`updateSession` / `loginWithSession` bind `SessionState` after stored fields are copied, overriding a stored `update`; detached/copied calls work (`unitTests/security/authSessions.test.js`). A property-assigned function literal pretenures its context (`CheckAssigningFunctionLiteralToProperty`), keeping the request graph until major GC (~1.8 KB/request, nearly 3× major GCs). Bind a module function or create a local first. `SESSION_VERSION` shares accessor functions: fresh functions put the clone in dictionary mode. `loadedSessions` keeps the record outside the request's function context.

## Conditional session updates are a best-effort pre-write check (`security/auth.ts`)

`updateSession` reads outside the request snapshot: RocksDB uses `COMMITTED_SESSION_READ`; LMDB renews its shared reader. It rejects non-live, changed, `VERSION_REUSED`, payload `version`, or versions beyond the clock and issuance floor before the ordinary put. In-flight, later or unreplicated writes can still race (#2983, `unitTests/security/sessionUpdateIfVersion.test.js`).

## User and role lookups read the records, and nothing derived from them outlives them (`security/user.ts`)

Lookups read `hdb_user` and `hdb_role` through the primary store cache: no per-thread copy, no change broadcast.

- **One committed state.** RocksDB point reads share no snapshot, so `readUserEntries` retries if the user's version moved during its role read.
- **Derived data uses entry versions, not identity**: the per-role memo, `isCurrentUser`, `auth.ts` cache hits and `trackUserRecords` (values for `VERSION_REUSED`).
- **Notifications are only for holders of a user.** `onUserChange` names the changed keys; none means unknown, so every holder rechecks. `userChangeNotificationEpoch()` is non-zero only while both subscriptions are open and every record since was read (RocksDB only), so a consumer seeing one non-zero epoch across a period was notified of every change in it; it never subscribes to an unaudited table, as `subscribe()` would persist auditing.
- **A request's user is a view.** `cloneUserView(user)` replaces `role` and `permission` without touching the cached principal and keeps provenance for subscription registration. An own symbol carries provenance across spreads with no request-path `WeakMap` write; only externally resolved users use `trackedProvenance`.

LMDB lookups share the thread's read txn, renewed per turn, not per lookup (a reader slot each). Enforced by `unitTests/security/userRecordLookups.test.js` and `unitTests/resources/replicatedUserWrites.test.js`.

### A component grant answers to its names ahead of every operations listing (`security/componentGrant.ts`)

A role's `component_deploy` grant (harper#3046) reaches `deploy_component`, `drop_component`, `get_deployment`, `list_deployments` and `get_components` for components its `names` match (`componentNameMatches`).

1. **The names are checked ahead of gate 2** (`verifyPerms`), which admits an allowlisted SU-only operation for any component. Gate 1 still applies.
2. **Deploy and drop check the name the handler resolves** (`canonicalProjectName`, else `projectNameFromPackage`); reads filter or refuse (`get_deployment`, 403) by the grant.
3. **`deployComponent` enforces `isolated`, `hostSuffix` and `branchedDatabases: required` on the origin** for the entry the release leaves in force, before writing, under the preparation lock and at activation; peers trust it.
4. **Only deploy credentials share the patterns** (harper#3090, `resolveCredentials`); runtime secrets (`components/componentSecrets.ts`) match exactly. `harper deploy setup=true` takes patterns only for github and npm.
5. **The key is `component_deploy`, not `components`**, a plausible database name (`RESERVED_DATABASE_NAMES`).
6. **`preview`, `maxPreviews` and `maxTtlDays` bound a preview identity**, below.

## PR previews are enabled by the cluster (`components/previewOperations.ts`)

`enable_previews`, `disable_previews` and `get_preview_policy` (harper#3042) manage one app's CI identity: role and user `<app>-ci-preview` (`CI_PREVIEW_OPERATIONS`, no table permissions, a `component_deploy` grant for `<app>-pr-*` with `preview: required`) and trust policies pinned to environments `preview` and `preview-cleanup`, the latter `drop_component` only, as required reviewers on `preview` gate every job there; without that pin the cleanup policy would also match the deploy job's token. `utility/previewIdentity.ts` names them for the CLI and Studio.

- **The policy is the grant.** `maxPreviews` and `maxTtlDays` sit in `component_deploy.constraints`, replicated and enforced on the origin; a super user gets only `deployment.previews.maxPerApplication`. The cap is per origin, counted under its lock: two origins can each take the last slot.
- **`preview: required` binds the metadata to the grant**: a deploy must carry `preview` naming app `A`, as `A-pr-<n>` with `A-pr-*` granted, or it escapes expiry and the cap. `maxTtlDays` (default 7) clamps `expiresAt` before replication; activation past it is refused before the live-release return.
- **Create-only, one per node at a time** (two apps sharing a workflow would both pass). Enable keeps matches, 409s on a differing record or overlapping policy (`policiesOverlap`, `sameAuthority`) and rechecks before writing, as `add_oidc_trust` replaces; other nodes are not excluded (#3127).
- **Disable revokes, then removes.** It drops the trust policies and deactivates the user; activation rechecks `isCurrentUser`. Its census is a barrier (#3613): `fence_preview_releases` has each node revoke the grant's `generation` under the per-app admission lock, then list what is live; stamped activations check that fence, so one under way finishes first and later ones fail. A grant activates only its generation's builds; silent nodes count as unreachable. Peers fence via `isOperationAuthorizationBypassed()`, not `REPLICATED_FROM`, which would also lift the deploy grant. Unfenced: a super user's preview; a pre-generation build in flight (rerun once `get_preview_policy`'s `inProgress` empties); and, bounded by expiry (#3805), late peer swaps, crash roll-forward, rollback or canary restore, and racing enables. Releases drop only while live on their node (`ifDeploymentId`; a non-origin drop stops before replicating), then the user and role; a failed, empty or unverifiable drop stops it, identity revoked, for a rerun.

## The password hash function and token lifetimes are read when used, never at module load (`security/user.ts`, `security/tokenAuthentication.ts`, `utility/password.ts`)

`harper run` on an empty root loads these modules (and `installer.ts`) before `install()` writes the config, and `install()` creates the admin before `runStartup()`, so no startup hook can fix the admin's hash. `authentication.hashFunction` is resolved per password write (`password.configuredHashFunction()`) and stored as the row's `hash_function`, which validation uses. `password.hash` defaults to it; `password.validate` to SHA-256, since the refresh-token check relies on that default (a config-driven one returns a Promise, and `!Promise` accepts a superseded token). Token lifetimes are read per mint. Enforced by `integrationTests/security/firstboot-auth-config.test.ts`.

## Local trust is a principal, not a stored user (`security/user.ts`, `security/auth.ts`)

A transport-trusted request (`authentication.authorizeLocal` from an `isLocalPeerAddress` peer, `bypassLocalAuth`, loopback MQTT, `bypassAuth()`) runs as `localPrincipal()`: a fixed super user `local` with no record, needing no users.

- **Recognized by its marker, never its name.** `isLocalPrincipal` checks `_localPrincipal: true`, which no `userView`, token, bearer-validator, OIDC or impersonation user gets; a string, so JSON (Bun/uWS fallback, MQTT will row) keeps it. `add_user` refuses the name; an older stored `local` is ordinary.
- **Never resolvable by name.** `session.update` never stores it; a credential-free `create_authentication_tokens` mints for `getSuperUser`'s first active super user or fails with 409. By-name rehydration checks `isLocalPrincipal` first: MQTT will replay rebuilds it; live-subscription re-authorization and MCP list_changed skip it.
- **Each call is a separate view**: shared system-table entries frozen, the table-name map mutable for registry updates, and a default install's `super_user` role, id included, as applications authorize on `role.id`.

Tests: `unitTests/security/localPrincipal.test.js` and `integrationTests/security/local-principal-token-mint.test.ts`.

## Named component children are identified by lifetime (`security/jsLoader.ts`, `security/spawnPidFile.ts`)

To avoid adopting or signaling a recycled PID or reusing a zombie ([#2968](https://github.com/HarperFast/harper/issues/2968)), `pids/<name>.pid` holds PID, version and OS birth identity, checked by adoption, version replacement, wrapper kill and exit observation. Records publish by write-then-rename. A failed or denied probe is unknown, never grounds to retire a record or emit exit; a Linux record from another boot is retired before probing. Spawn/adoption probes run under the lock. No signal-zero fast path: a reused live PID would hold an exited wrapper open. Legacy records are retired unsignaled, with a warning; older builds ignore the identity line. Gaps: the check-to-signal race and OS timestamp resolution (fixing either needs native PID handles), same-boot hidepid/ProtectProc probes (operator repair), a child left unrecorded by a crash before publication, and one legacy child coexisting during an upgrade.

Synchronous spawning takes a filesystem bakery lock of per-UUID claims (ordering shared with `componentPreparationLock.ts`); stale removal targets only its UUID. A cached foreign identity can delay reclamation, never authorize it. An unlinkable claim gets a release marker that scans honor before reading the claim; Windows sharing errors are retried. Acquisition, publication and exit cleanup share the claim protocol, so no stale checker or older child's exit removes a newer record. Waits fail after 60 s without progress (later arrivals cannot renew a stalled wait), never stealing from a live process; probes time out at 30 s. Exit cleanup tries once, without waiting or probing. Release failures never replace the spawn result; if both claim removal and marker publication fail, an operator must repair or restart. A dead worker's claim blocks until Harper restarts; unreadable owners fail closed. Enforced by `unitTests/components/spawnPidIdentity.test.js`, `unitTests/components/spawnPidFile.test.js` (both Windows-gated) and `integrationTests/components/named-process.test.ts`.

On Windows, version replacement's `process.kill(pid)` sets `ChildProcess.exitCode`, not `signalCode`.

Probe and lock failures throw `NamedProcessError` (a `ServerError` with the cause); native argument errors keep their class and code.

## Application lockdown seals the intrinsics by default (`security/intrinsicsLockdown.ts`)

`applications.lockdown` defaults to `seal-after-load` on fresh installs; upgrades keep theirs, as the installer writes the whole config. Sealing, realm originals included, blocks adding or deleting intrinsic properties but allows overwrites; it is not a sandbox. Seal-mode prototype properties stay writable data: read-only ones cost array-hole stores their V8 fast path, accessors block built-in inlining; only freeze modes need `overridableProperty`. Freezing covers current globals only, leaving `Function.prototype` extensible. Unknown truthy modes freeze (fail closed); falsy ones skip. Tests: `unitTests/security/intrinsicsLockdown.test.js` (fresh workers), `integrationTests/components/intrinsics-lockdown.test.ts`; measurements: `benchmarks/lockdown/run.mts`.

## A scoped mirror is never advertised before its allowlist is read (`security/networkAccess.ts`)

`system.hdb_network_access` holds one replicated row per scope (`operations` today) for a fronting proxy to enforce; Harper publishes it as `allowedSources` in UDS mirror metadata (`writeUdsMetadata`, `server/http.ts`).

- **No unrestricted advertisement.** The writer, not `ready`, holds a scoped mirror until the thread's first successful read, as `security/keys.ts` fires `secureContextsListeners` before readiness. A table absent after databases load means unrestricted.
- **One reconciler per scope.** Subscription events, the 60 s tick and `onUpdatedTable` only trigger one serialized `table.get(scope)`; payloads are ignored, so a missed event converges on the next read; the tick retries failed writes.
- **Lockout check.** `set_network_access` refuses a list excluding the caller's address (`runWithCallerAddress`, never the body); only the operations domain socket skips it, and other unknown addresses need `force`. Matching unmaps `::ffff:a.b.c.d` like the proxy. Unlisted proxied peers only get a warning.

## Resource attribute permissions

`getTablePermissions` adds the unlisted key's `implicitPrimaryKeyPermission`; operations translation drops listed undeclared properties. Explicit key denials, timestamps and sealed membership apply. `updatedAttributes` resets the permission memo.

`allowUpdate` keeps `allowTableUpdate`'s map through puts/locks until its next call. Payloads omit protected values. `restrictedReplacement` patches full puts so no protected base goes stale; omitted writable keys stay own `undefined` properties. Restricted source writes use implemented `patch` or materialized `put`. PATCH limits: delete/retry can create partial rows, put-only sources with cold/stale caches can lose protected values, `__op__` values are operations. Invalid full roots are refused. Trusted direct PATCH/create thenables check resolved keys but store original fields. Dispatch resolves bodies; helpers reject failed promises without override re-entry. Tests: `unitTests/resources/permissions.test.js`, `unitTests/server/preconditions.test.js`, `integrationTests/security/resource-attribute-permissions.test.ts`. Gaps: commit-time retry, crash replay, replication apply.

## System permissions on roles

`permission.system` derives from `super_user` and the registry. Held identities share mutable maps with frozen entries. API declarations return 400; files strip and warn on changed contents, not replay. Legacy copies strip without writes that could race `alter_role`; warnings dedupe by revision/thread. Impersonation reinstalls managed maps; scoped tokens strip before hashing to avoid MCP churn. External response reuse is per-call; listeners are lazy to avoid the Resource import cycle.
