---
section: 'Component Deploys'
order: 55
---

### Failed Component Loads Close Their Scope

When a component load fails on a worker thread (for example, when `handleApplication()` or an initial entry load rejects, or when the load or its lock wait times out), Harper now closes the component's `Scope` instead of leaving its file watchers, options watcher, deploy-lifecycle listeners, and secret-subscription holds open until the worker exits (when an initial entry load fails, one recovery watcher per failed entry handler stays open until the next file edit, reload, or shutdown so correcting the file still requests a restart). `scope.close()` also now removes remaining listeners and releases the component's secret subscriptions even when a `'close'` listener throws or rejects. See [`scope.close()`](/reference/v5/components/plugin-api#scopeclose).
