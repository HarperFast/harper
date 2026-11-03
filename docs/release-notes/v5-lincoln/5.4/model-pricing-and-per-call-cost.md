---
section: 'Models'
order: 10
---

### Model Pricing and Per-Call Cost

A `models.generative` entry can now declare `pricing: { inputPerMtok, outputPerMtok }`, what you pay in USD per million prompt and completion tokens. Harper ships no prices of its own. Each `generate()` call is priced at the rates of the entry that served it, a fallback included, and the result carries `costUsd` when that entry is priced and the provider reported both token counts. With `toolMode: 'auto'` it covers the final round, and streaming calls are not priced. This makes `maxCostUsd` work on `toolMode: 'auto'` calls; before, it had no prices behind it and never tripped. A `toolMode: 'auto'` round that leaves `maxCostUsd` or `maxToolTokens` unmeasurable, because the entry is unpriced or the provider reported no token counts, now stops the call with the budget error (429) instead of warning once and continuing, so set `pricing` on entries you cap by cost. See [Pricing](/reference/v5/models/overview#pricing).
