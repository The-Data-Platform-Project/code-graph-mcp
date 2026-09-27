# Diagnostics

Scripts for checking the parts pytest can't reach: the database in Supabase,
the Vercel project, and the live deployment. They are run by hand, not by pytest
(none are named `test_*.py`, so the suite never collects them).

Run everything from WSL as `ismail`, from anywhere: each script finds the repo
from its own location. Python scripts use the dev venv:
`~/cgvenv/bin/python tests/diagnostics/<script>.py`.

None of them prints a secret. Passwords and URLs are read at hidden prompts and
reported only as lengths and character classes.

## Which one do I need?

| Situation | Script |
|---|---|
| Before changing code, or before committing | [`run_tests.sh`](#run_testssh) |
| About to load a SQLite graph into Supabase, or the load failed | [`inspect_sqlite_graph.py`](#inspect_sqlite_graphpy) |
| New Supabase project, or "Tenant or user not found" | [`probe_pooler.py`](#probe_poolerpy) |
| Before putting a `DATABASE_URL` in Vercel, or the app says "password authentication failed" | [`check_db_url.py`](#check_db_urlpy) |
| The URL works locally but not on Vercel | [`set_vercel_db_url.py`](#set_vercel_db_urlpy) |
| Is Vercel set up right? Which env vars are there? | [`vercel_status.sh`](#vercel_statussh) |
| Just pushed to the production branch | [`wait_for_deploy.sh`](#wait_for_deploysh), then [`smoke_prod.sh`](#smoke_prodsh) |
| Site is up but something returns 500 | [`smoke_prod.sh`](#smoke_prodsh) (prints the server's errors) |
| Does the driver read my password's special characters right? | [`pg_url_parsing.sh`](#pg_url_parsingsh) |

For the *indexer's* database (the local container, `DATABASE_URL` in your
environment), use `scripts/check_db.py` instead. It diagnoses IPv6-only hosts
and missing tables in `public`. The scripts here are about the cloud app.

## The usual order for a new Supabase project

1. `probe_pooler.py`: the project and `postgres` user exist.
2. `inspect_sqlite_graph.py`: decide what to `--exclude`, then load with
   `scripts/load_sqlite_to_supabase.py`.
3. Create `codegraph_app` (docs/ADMIN_GUIDE.md §2.2), then `check_db_url.py`
   with its URL.
4. `set_vercel_db_url.py` to store that URL; the other variables with
   `vercel env add`. Then `vercel_status.sh` to see them all.
5. Push or redeploy, `wait_for_deploy.sh`, `smoke_prod.sh`.

---

## `run_tests.sh`

**When:** before and after any code change; before every commit.

Runs pytest against the `data-platform-postgres-1` container (the graph's
Postgres on this machine) and ruff on the Python files you've changed. The
container publishes no host port, so the script finds its IP on the Docker
network and builds `TEST_DATABASE_URL` from the container's superuser. The
loader tests need `CREATE DATABASE`, which the `codegraph` role lacks.

```bash
tests/diagnostics/run_tests.sh
tests/diagnostics/run_tests.sh -k sqlite_import       # extra args go to pytest
CONTAINER=other-postgres tests/diagnostics/run_tests.sh
```

Ruff only looks at changed files because the tree has older style findings
(`Optional[...]`, unused `noqa`) that would bury anything new. Ruff findings
don't fail the run; test failures do.

## `inspect_sqlite_graph.py`

**When:** before `scripts/load_sqlite_to_supabase.py`, and whenever it fails
with `index row size ... exceeds btree version 4 maximum 2704`.

Read-only. For `data/graph.db` (or a path you give) it lists every repo with its
indexed path and counts. It flags a repo whose path is `.`, meaning it was
indexed from the root of the mount (the whole F: drive), and shows what it
really contains. It lists values too large for a Postgres index, and inline
`data:` URIs recorded as imports. Finally it prints the `--exclude` flags to
pass to the loader.

```bash
~/cgvenv/bin/python tests/diagnostics/inspect_sqlite_graph.py
~/cgvenv/bin/python tests/diagnostics/inspect_sqlite_graph.py data/graph.db --repo care-pk
```

Background: the first load into the Singapore project failed on
`telemetry-pipeline`. It was indexed with path `.`, so it held VS Code, Packet
Tracer and `$RECYCLE.BIN`, and it had base64 images up to 185 KB recorded as
HTML imports. The extractors skip `data:` URIs now, but old SQLite graphs still
contain them.

## `probe_pooler.py`

**When:** after creating a Supabase project or changing its region, and when
anything reports `Tenant or user not found`.

Logs in to both pooler ports with a deliberately wrong password and reads the
refusal. That tells you whether the project and user exist without needing the
password.

| It says | Meaning |
|---|---|
| `password authentication failed` | host, project ref and user are right (good) |
| `Tenant or user not found` | wrong project ref, wrong region's pooler host, or user without `.<ref>` |
| timeout / cannot resolve | network, or a mistyped host |

```bash
~/cgvenv/bin/python tests/diagnostics/probe_pooler.py
~/cgvenv/bin/python tests/diagnostics/probe_pooler.py --user codegraph_app.rryfmnktebyvfxaftvyv
```

Defaults come from `src/code_graph/pgcli.py`, so they follow the project the
admin scripts use.

## `check_db_url.py`

**When:** before giving a `DATABASE_URL` to Vercel, and when the app logs
`password authentication failed for user "codegraph_app"`.

Asks for the URL at a hidden prompt. It shows how the URL parses: user, host,
port, database, the password's length, and any characters that should be
percent-encoded. It flags a placeholder like `<password>` left in. Then it logs
in, on the session pooler too for a transaction-pooler URL, and counts
`tenant_owner.nodes`, which proves the role's grants as well as its password.

```bash
~/cgvenv/bin/python tests/diagnostics/check_db_url.py
```

| Result | Next step |
|---|---|
| OK on both ports, but the app still fails | Vercel holds a different value: `set_vercel_db_url.py` |
| `password authentication failed` | re-run `ALTER ROLE codegraph_app WITH PASSWORD '…'` in *this* project's SQL Editor |
| `permission denied for schema/table` | the GRANTs in ADMIN_GUIDE §2.2 are missing |
| `Tenant or user not found` | the user needs the `.<project-ref>` suffix |

## `set_vercel_db_url.py`

**When:** `check_db_url.py` says the URL works but production still can't log
in. Also use it whenever you set `DATABASE_URL` at all, since it rules out
typos.

Reads the URL once (hidden) and runs the same login test. Only if that passes
does it pipe that exact string, with the user and password percent-encoded, to
`vercel env add DATABASE_URL <target> --sensitive --force`. If the test fails,
Vercel is left unchanged. Redeploy afterwards: a variable only reaches the site
in the next build.

```bash
~/cgvenv/bin/python tests/diagnostics/set_vercel_db_url.py
~/cgvenv/bin/python tests/diagnostics/set_vercel_db_url.py --target preview
```

Why it exists: a URL that logged in locally still failed on Vercel, because the
value typed at `vercel env add`'s hidden prompt wasn't the same string.

## `vercel_status.sh`

**When:** before a deploy, after changing project settings, or when unsure what
the project is set to.

Read-only. It shows the CLI login and the `frontend/` link, then Root Directory
and Framework (flagged unless they are `frontend` and `nextjs`), the production
branch, every environment variable by name, and the latest deployment.

```bash
tests/diagnostics/vercel_status.sh
```

Sensitive variables can't be read back by anyone, including this script. To
test a value, use the scripts above before storing it.

## `wait_for_deploy.sh`

**When:** right after `git push` to the production branch, or `vercel redeploy`.

Polls every 10 seconds until the deployment of that commit is `READY` (exit 0)
or `ERROR`/`CANCELED` (exit 1, with the command to see the build log). It waits
up to 10 minutes; set `TIMEOUT` in seconds to change that.

```bash
tests/diagnostics/wait_for_deploy.sh            # HEAD
tests/diagnostics/wait_for_deploy.sh 99d65da
```

A `vercel redeploy` rebuilds an existing commit, so its deployment matches that
commit's SHA too.

## `smoke_prod.sh`

**When:** after every deploy, and first thing when the site misbehaves.

Checks the app without logging in:

| Check | Expect | Proves |
|---|---|---|
| `/api/health` | 200 | the functions run |
| `/` | 307 | the page gate redirects to `/login` |
| `/login` | 200 | the login page renders |
| `/api/mcp`, no token | 401 | the MCP route answers and rejects anonymous calls |
| `/api/mcp`, fake token | 401 | **the database works**: rejecting a token means looking it up in `control.mcp_tokens` |

A 500 on the fake-token check is a database problem. When anything fails, the
script prints the last 10 minutes of server errors, with a key to the common
ones (password, certificate, grants, too-short secrets).

```bash
tests/diagnostics/smoke_prod.sh
tests/diagnostics/smoke_prod.sh https://code-graph-abc123.vercel.app
```

It can't test signing in, because that needs `OWNER_PASSWORD`. Do that in the
browser.

## `pg_url_parsing.sh`

**When:** a password has special characters and you want to know whether the
app's driver reads it the way you mean.

Installs the `pg` and `pg-connection-string` versions pinned in
`frontend/package-lock.json` into a throwaway folder, not the app's
`node_modules`. It then parses a URL twice: as given, and after `new URL()`,
which is what `frontend/lib/pool.ts` does when `DATABASE_CA_CERT` is set. The
string is printed, so **use a made-up password** with the same characters.

```bash
tests/diagnostics/pg_url_parsing.sh 'postgresql://u.ref:fake@pa#ss@host:6543/postgres'
```

Recorded 2026-09-28 with pg 8.23.0: an unencoded `@` parses correctly both
ways, but an unencoded `#` does not. In the example above, the driver sees
password `fake` and host `pa`. `?`, `/`, `%` and `:` aren't safe unencoded
either. `set_vercel_db_url.py` encodes all of them for you.
