---
section: 'Component Deploys'
order: 55
---

### Failed Component Loads Close Their Scope

When a component load fails on a worker thread (for example, when `handleApplication()` or an initial entry load rejects, or when the load or its lock wait times out), Harper now closes the component's `Scope` instead of leaving its file watchers, options watcher, deploy-lifecycle listeners, and secret-subscription holds open until the worker exits. `scope.close()` also now removes remaining listeners and releases the component's secret subscriptions even when a `'close'` listener throws or rejects. See [`scope.close()`](/reference/v5/components/plugin-api#scopeclose).
