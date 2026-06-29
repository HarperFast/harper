// QA-328 — concurrent PATCH field-level merge correctness
//
// No custom resource logic needed — REST is enabled so Harper exposes:
//   GET/PUT/PATCH/DELETE /CollabDoc/:id
//
// PATCH /CollabDoc/:id  body: partial fields  → merge into existing record
// PUT /CollabDoc/:id    body: full record      → replace entire record
//
// All tests drive these endpoints directly via fetch().
