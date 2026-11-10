---
section: 'Subscriptions'
order: 10
---

### Resuming a Subscription From a Checked Position

A `subscribe` request can now carry the `databaseGeneration` its position came from. Harper then checks the position before and during the replay, and refuses one whose history was replaced (`DatabaseGenerationChangedError`, status code 409) or pruned (`ResumeHistoryUnavailableError`, status code 410) instead of replaying what is left. The subscription's `resumeVerified` promise resolves `true` once the replay is complete and checked. Requests without the field behave as before, and the check applies to RocksDB databases only. See [Resuming from a position](/reference/v5/resources/resource-api#resuming-from-a-position).
