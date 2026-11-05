---
section: 'Upgrade Notes'
order: 5
---

MCP clients using expiring credentials must renew their subscriptions before expiry. Harper preserves the original subscribing POST expiry across workers and reconnects; an open GET does not guarantee that updates are still being delivered. Open a replacement GET and re-subscribe each URI with the new credential. See [Subscription lifetime and credential rotation](/reference/v5/mcp/subscriptions#subscription-lifetime-and-credential-rotation).
