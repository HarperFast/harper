---
section: 'Memory'
order: 10
---

### Smaller Per-Thread Baseline

An idle Harper thread now uses roughly 40% less JavaScript heap (about 58 MB down to 35 MB in a default install, before any application code loads). Harper's compiled code is smaller in memory, and several dependencies used only by specific features (LMDB storage, certificate revocation checks, certificate generation, `system_information`) now load when that feature is first used.

Source maps are no longer enabled by default, so stack traces from Harper's core point at its compiled JavaScript. If you control the process environment (not on Fabric clusters that Harper hosts), set `NODE_OPTIONS=--enable-source-maps` to map them back to the TypeScript sources. See [Source Maps in Stack Traces](/reference/v5/configuration/debugging#source-maps-in-stack-traces).
