---
section: Storage
---

### Auto-Assigned Ids Keep Working in a Table With Two Record Shapes

On RocksDB, a table with auto-assigned numeric ids could store its id range in a form that read back as missing. This happened when the table's first auto-assigned id came after records of exactly two different shapes. An insert of many records without ids then failed with a 500 (`Cannot read properties of undefined (reading 'value')`), and every restart started a new id range. The range is now stored so that it always reads back. A range an earlier version stored that cannot be read is replaced on the next insert without an id. That insert starts a new range, so the ids left in the old range are skipped.
