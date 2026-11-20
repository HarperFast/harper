---
section: 'Models'
---

### Vector Search by Text

A vector `sort` on an `@embed` attribute can pass `text` instead of a `target` vector: `Document.search({ sort: { attribute: 'embedding', text: 'what is harper?' } })`. Harper embeds the text with the attribute's own model as a search query (`inputType: 'query'`) and ranks records by it, with `$distance` available as before. The operations API's `search_by_value` and `search_by_conditions` take the same sort, so an operations-API client can search by text without computing the vector itself. A failure to embed the text or to open the search is the response's status, never a cut-off stream, and a request that would fail anyway is refused before the model is called. See [Searching by Text](/reference/v5/database/schema#searching-by-text) ([harper#1277](https://github.com/HarperFast/harper/issues/1277)).
