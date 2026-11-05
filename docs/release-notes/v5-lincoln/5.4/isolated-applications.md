---
section: 'Pull Request Previews'
order: 50
---

### Isolated Applications

- The shared workers answer a request for an isolated application's `host` with `503` and `Retry-After: 5`, and close a WebSocket for it with `1013`, instead of serving another application's routes. See [Reaching an isolated application](/reference/v5/components/applications#reaching-an-isolated-application).
- In an isolated application, and under the `vm` and `compartment` module loaders, the bare `databases` and `tables` globals now reach the application's branched databases, as importing them from `harper` already did. See [Reaching the fork from code](/reference/v5/components/applications#reaching-the-fork-from-code).
- An isolated application with a `host` can load `fastifyRoutes`, which a host-mounted application in the shared workers still cannot. See [What a mount does not do](/reference/v5/http/overview#what-a-mount-does-not-do).
- `http.corsAccessList` and `operationsApi.network.corsAccessList` accept an origin such as `https://*.app.example.com`, where `*` is any one label. See [`http.corsAccessList`](/reference/v5/http/configuration#httpcorsaccesslist).
