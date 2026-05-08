#!/usr/bin/env python3
"""
Wrap top-level `CREATE POLICY ...;` statements in a DO block that swallows
`duplicate_object` errors, leaving every other statement untouched.

Why this exists
---------------
The GDPR real-DB CI job (scripts/test-gdpr-real-db.sh) replays every
supabase/migrations/*.sql against an empty Postgres. Four historical
migrations re-declare a CREATE POLICY that an earlier migration already
created, without an `if not exists` guard (Postgres doesn't even support
that for CREATE POLICY today). On the live database those duplicates were
never re-applied, so they look fine; on a fresh CI cluster they explode.

The CI script needs to run with strict ON_ERROR_STOP so that a *real*
breakage in `delete_user_data()` or one of the per-user tables fails
loudly. To keep that strictness without false positives from those four
known duplicates, this script narrowly transforms only standalone
`CREATE POLICY` statements:

    create policy "X" on public.t for select using (auth.uid() = user_id);

becomes

    do $wrap$ begin
      create policy "X" on public.t for select using (auth.uid() = user_id);
    exception when duplicate_object then null; end $wrap$;

Every other statement type — including a CREATE POLICY embedded inside a
function body — is passed through verbatim. If a future migration
introduces a CREATE POLICY drift (wrong table, wrong predicate) the
function/table call sites in the real-DB test will still surface it.

Usage:
    python3 wrap_create_policy.py < input.sql > output.sql
"""
from __future__ import annotations

import sys
import re


def split_top_level_statements(sql: str) -> list[str]:
    """
    Split SQL on top-level semicolons, ignoring semicolons inside:
      - single-quoted strings ('...'),
      - double-quoted identifiers ("..."),
      - dollar-quoted strings ($tag$ ... $tag$),
      - line comments (-- ...),
      - block comments (/* ... */),
      - parentheses.
    Returns each statement WITH its trailing semicolon.
    """
    parts: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(sql)
    paren_depth = 0
    in_squote = False
    in_dquote = False
    in_line_comment = False
    in_block_comment = False
    dollar_tag: str | None = None  # current dollar-quote tag, e.g. "$$" or "$wrap$"

    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if in_line_comment:
            buf.append(c)
            if c == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            buf.append(c)
            if c == "*" and nxt == "/":
                buf.append(nxt)
                i += 2
                in_block_comment = False
                continue
            i += 1
            continue
        if dollar_tag is not None:
            # inside a dollar-quoted string, look for closing tag
            if sql.startswith(dollar_tag, i):
                buf.append(dollar_tag)
                i += len(dollar_tag)
                dollar_tag = None
                continue
            buf.append(c)
            i += 1
            continue
        if in_squote:
            buf.append(c)
            if c == "'":
                # standard SQL doubled '' to escape; consume both
                if nxt == "'":
                    buf.append(nxt)
                    i += 2
                    continue
                in_squote = False
            i += 1
            continue
        if in_dquote:
            buf.append(c)
            if c == '"':
                if nxt == '"':
                    buf.append(nxt)
                    i += 2
                    continue
                in_dquote = False
            i += 1
            continue

        # Not inside any string/comment.
        if c == "-" and nxt == "-":
            in_line_comment = True
            buf.append(c)
            buf.append(nxt)
            i += 2
            continue
        if c == "/" and nxt == "*":
            in_block_comment = True
            buf.append(c)
            buf.append(nxt)
            i += 2
            continue
        if c == "'":
            in_squote = True
            buf.append(c)
            i += 1
            continue
        if c == '"':
            in_dquote = True
            buf.append(c)
            i += 1
            continue
        if c == "$":
            # Try to match a dollar-quote tag: $[tag]$
            m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])
            if m:
                dollar_tag = m.group(0)
                buf.append(dollar_tag)
                i += len(dollar_tag)
                continue
        if c == "(":
            paren_depth += 1
            buf.append(c)
            i += 1
            continue
        if c == ")":
            if paren_depth > 0:
                paren_depth -= 1
            buf.append(c)
            i += 1
            continue
        if c == ";" and paren_depth == 0:
            buf.append(c)
            stmt = "".join(buf)
            if stmt.strip():
                parts.append(stmt)
            buf = []
            i += 1
            continue

        buf.append(c)
        i += 1

    tail = "".join(buf)
    if tail.strip():
        parts.append(tail)
    return parts


_CREATE_POLICY_RE = re.compile(r"^\s*create\s+policy\b", re.IGNORECASE)


def wrap_if_create_policy(stmt: str) -> str:
    """
    If `stmt` is a top-level CREATE POLICY statement, wrap it in a DO
    block that swallows duplicate_object errors. Otherwise return as-is.
    """
    # Strip leading comments/whitespace to test the first real keyword,
    # but emit the original text inside the wrapper so comments survive.
    leading = ""
    body = stmt
    while True:
        m = re.match(r"\s*(--[^\n]*\n|/\*.*?\*/|\s+)", body, re.DOTALL)
        if not m:
            break
        leading += m.group(0)
        body = body[m.end():]

    if not _CREATE_POLICY_RE.match(body):
        return stmt

    # Strip trailing semicolon from body for clean nesting; the DO block
    # supplies its own.
    body_stripped = body.rstrip()
    if body_stripped.endswith(";"):
        body_stripped = body_stripped[:-1]

    wrapped = (
        f"{leading}do $wrap_create_policy$ begin\n"
        f"  {body_stripped};\n"
        f"exception when duplicate_object then null; end $wrap_create_policy$;"
    )
    return wrapped


def transform(sql: str) -> str:
    return "".join(wrap_if_create_policy(s) for s in split_top_level_statements(sql))


if __name__ == "__main__":
    sys.stdout.write(transform(sys.stdin.read()))
