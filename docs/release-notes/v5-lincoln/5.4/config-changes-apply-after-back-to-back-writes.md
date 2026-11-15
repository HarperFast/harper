---
section: 'Configuration'
---

### Configuration Changes Keep Applying After Back-to-Back Writes

[Logging](/reference/v5/logging/configuration), model and full-text analytics settings, which Harper applies without a restart, no longer stop updating after two writes to `harper-config.yaml` land close together. Harper writes the file by replacing it, and when a second replacement came within a few milliseconds of the first (two `set_configuration` calls in a row, or a certificate update followed by another setting), the file watch could stay on the replaced file. Every later change was then ignored until a restart. This happened mostly on macOS. Harper now notices when the file at the path is no longer the one it is watching, and watches the new one.
