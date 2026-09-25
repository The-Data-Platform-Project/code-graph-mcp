"""Connection options shared by the admin scripts (loader, tokens, parity).

Defaults point at the Supabase **session pooler** (IPv4, port 5432): the direct
db.<ref>.supabase.co host is IPv6-only, and the transaction pooler (6543) does
not suit long transactions. The password is prompted for and never echoed.
$DATABASE_URL or --dsn points anywhere else.
"""

from __future__ import annotations

import argparse
import getpass
import os

import psycopg
from psycopg.rows import dict_row


def add_connection_args(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"),
                    help="full connection string (default: $DATABASE_URL, else Supabase)")
    ap.add_argument("--host", default="aws-0-ap-southeast-2.pooler.supabase.com")
    ap.add_argument("--port", default="5432")
    ap.add_argument("--user", default="postgres.rkeuovfdmmjebechozev")
    ap.add_argument("--db", default="postgres")


def describe(args: argparse.Namespace) -> str:
    return "DATABASE_URL" if args.dsn else f"{args.user}@{args.host}:{args.port}/{args.db}"


def connect(args: argparse.Namespace) -> psycopg.Connection:
    if args.dsn:
        return psycopg.connect(args.dsn, row_factory=dict_row)
    return psycopg.connect(
        host=args.host, port=args.port, user=args.user, dbname=args.db,
        password=getpass.getpass(f"  Password for {args.user}: "),
        sslmode="require", connect_timeout=15, row_factory=dict_row,
    )
