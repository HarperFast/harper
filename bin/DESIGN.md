# bin/ — Design notes

The `harper` CLI: argument parsing, the operations client, login and backup commands.

**Read this when:** touching how a CLI command picks its target, credentials or `.env` loading (`cliCredentials.ts`, `cliOperations.ts`, `login.ts`, `backup.ts`).

Index of every design note: [DESIGN.md](../DESIGN.md).

---

## Neither the working directory nor a server reply picks the CLI's target (`bin/cliCredentials.ts` `loadCliDotenv`)

- The working directory is often a cloned project, so its `.env` must not decide where credentials go. Every CLI entry that reads `.env` calls `loadCliDotenv()`, never `dotenv.config()`: it stages the file, refuses the whole file if it would supply a `CLI_TRUST_ENV_KEYS` name (targets, usernames/passwords and tokens in both namespaces, the Actions identity-request pair, `GITHUB_REPOSITORY`, `HOME`/`USERPROFILE` (they locate the saved login), TLS/proxy switches) the inherited environment does not set, and only then applies it without overriding. Names compare upper-cased, since Windows environment names are case-insensitive.
- Refuse, never ignore: dropping the key would fall through to the saved `last_target` (another cluster) or, in `runBackupCommand`, to offline restore/delete on local files. That is why it is the first statement of `runBackupCommand`, ahead of `useOperationApi`.
- `logout` loads no `.env` (it reads no environment); `harper agent` and `harper mcp` never did.
- `login` saves the tokens and `last_target`, and prints, under its own normalized target, never a field of the reply, and it does not write the project `.env`.
