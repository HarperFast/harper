---
section: 'Security'
---

### Sealed Operations Through a Relay

`encrypted_operation` runs an operation that the client sealed to the node's secrets custody key, and seals the result back under a key the client chose, so a proxy or control plane that relays the request sees only ciphertext in both directions. The sealed operation runs as the user who sent the request and is authorized exactly as if sent directly. `"mode": "fields"` keeps the operation's keys and chosen values readable, so a relay can record what was attempted, and seals the rest. A per-node nonce store and a freshness window refuse replays; `operationsApi.encryptedOperation.maxAge` and `.maxSize` size the window and the largest answer. Requires secret custody (Harper Pro). See [Encrypted Operations](/reference/v5/operations-api/operations#encrypted-operations) ([harper#3288](https://github.com/HarperFast/harper/issues/3288)).
