---
section: 'Security'
order: 40
---

### Configuration and Key Files Are Readable Only by Harper's User

On Linux and macOS, Harper now creates the configuration file, its backups, the environment-configuration state file, the JWT signing key and its passphrase, and the private keys it generates readable only by the user it runs as (mode `600`). Before, they had the mode your umask gave a new file, usually `644`, and every configuration change reset it, so a `chmod` you applied did not last. Now a mode you set to be stricter, such as `400`, survives Harper's writes.

Files written by earlier versions keep their modes until Harper next rewrites them, and old backups are never rewritten: run the `chmod` in [File Permissions](/reference/v5/configuration/overview#file-permissions) once after upgrading, and rotate any credential or key other local users could already read. Windows is unchanged ([harper#1925](https://github.com/HarperFast/harper/issues/1925)).
