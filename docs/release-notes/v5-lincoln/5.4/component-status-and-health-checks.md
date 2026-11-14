---
section: 'Analytics'
---

### Component Status and Health Checks

Loggers have a `.status()` call that records a component's current state, such as `logger.status({ problem: 'queue.overloaded', expires: 120 }).error('Queue is full')`, and `get_status` reports it. With `components: true`, `get_status` also returns a component tree whose parents show the worst status of their children; the flat `componentStatus` list is unchanged. New health checks poll disk, memory and CPU against the instance's own limits (storage quota, cgroup memory and CPU quota) every `status.healthChecks.intervalSeconds` (default `60`), with warning and error thresholds of 80/95% for disk and memory and 85/95% for CPU. Recoverable events such as an uncaught worker exception expire after 120 seconds. Health-check settings take effect on restart ([harper#372](https://github.com/HarperFast/harper/pull/372)).
