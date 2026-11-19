---
section: 'Security'
order: 30
---

### A Login Server No Longer Picks the Saved Target

`harper login` now saves and prints the URL you gave it, and writes that URL to a project `.env`, never a target named in the server's reply. Before, a login server could choose which target its tokens were saved under and add a line to `.env`.
