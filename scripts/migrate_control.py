#!/usr/bin/env python3
"""Create or upgrade the control schema, and grant the app's role what it needs.

    python scripts/migrate_control.py                          # DDL only
    python scripts/migrate_control.py --app-role codegraph_app # DDL + grants

Idempotent: every statement is CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT
EXISTS or CREATE OR REPLACE, so it is safe to re-run after every deploy that
changes src/code_graph/control.py. Run it as the database owner (`postgres` on
Supabase), not as the app's role, which cannot run DDL. The indexer Lambda
also runs the DDL on a cold start, but the web app needs the tables before
the first index job ever exists, so run this once by hand.

Connection options are the loader's: the Supabase session pooler by default,
or $DATABASE_URL / --dsn.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from code_graph import control, pgcli  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    pgcli.add_connection_args(ap)
    ap.add_argument("--app-role", help="the web app's login role, e.g. codegraph_app")
    args = ap.parse_args()

    with pgcli.connect(args) as con:
        control.ensure_control(con)
        if args.app_role:
            control.grant_app_role(con, args.app_role)
        con.commit()
    print(f"  control schema up to date on {pgcli.describe(args)}")
    if args.app_role:
        print(f"  grants applied to {args.app_role}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
