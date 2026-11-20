---
section: 'Configuration'
---

### The Configuration Schema Matches the MQTT Settings Harper Reads

`config-root.schema.json`, which editors and Studio use to validate and describe `harper-config.yaml`, now places the MQTT `port`, `securePort` and `mtls` settings under [`mqtt.network`](/reference/v5/mqtt/configuration), where Harper reads them, and flags them when they sit directly under `mqtt`, where Harper ignores them. Its `certificateVerification` options for HTTP, replication and MQTT match what Harper accepts: `crl` and `ocsp` may be `true` or `false`, and a timeout or cache lifetime below Harper's minimum is flagged instead of turning revocation checking off. The MQTT reference page no longer shows a `certificateVerification` shape Harper rejects, and `authentication.refreshTokenTimeout` documents its `30d` default. The schema's stated defaults now match the installed configuration, and the reference pages say that [`http.cors`](/reference/v5/http/configuration) and [`authentication.authorizeLocal`](/reference/v5/security/configuration) default to `false`, with `harper install` writing `true` for both in dev mode.
