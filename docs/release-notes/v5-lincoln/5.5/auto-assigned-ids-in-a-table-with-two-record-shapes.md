---
section: Storage
---

### Auto-Assigned Ids Keep Working in a Table With Two Record Shapes

On RocksDB, a table with auto-assigned numeric ids could store its id range in a form that read back as missing. This happened when the table's first auto-assigned id came after records of exactly two different shapes. An insert of many records without ids then failed with a 500 (`Cannot read properties of undefined (reading 'value')`), and every restart started a new id range. The same error followed a table's `clear()` on either engine, at the next range extension, because `clear()` removed the stored range. The range is now stored so that it always reads back, a missing range is stored again from the next id, so ids continue after a `clear()` (a restart before that next range is stored takes a new range), and a range an earlier version stored is read back and continued.
