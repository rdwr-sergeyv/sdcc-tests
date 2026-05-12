#!/usr/bin/env python3
"""CDDOS-2426 — Source contract check: migrate_V24 must not unconditionally clear fail_over.

This check FAILS on the current buggy code (which does $set: {fail_over: None} on every
existing zone without checking the current value) and PASSES once the fix adds a conditional
guard before overwriting fail_over.

No Django/SDCC imports are used; this is a pure AST/source-text check.
"""

import argparse
import ast
import os
import re
import sys


def _repo_root():
    current = os.path.abspath(os.path.dirname(__file__))
    for _ in range(4):
        current = os.path.dirname(current)
    return current


def _read(root, relative_path):
    path = os.path.join(root, relative_path)
    with open(path, 'r', encoding='utf-8') as fh:
        return path, fh.read()


def _find_function_in_module(module, name):
    for node in ast.walk(module):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    return None


def _node_text(source, node):
    return ast.get_source_segment(source, node) or ''


def _assert_contains(checks, label, text, pattern):
    matched = re.search(pattern, text, flags=re.MULTILINE | re.DOTALL) is not None
    checks.append((label, matched))


def _assert_not_contains(checks, label, text, pattern):
    matched = re.search(pattern, text, flags=re.MULTILINE | re.DOTALL) is None
    checks.append((label, matched))


def _assert_true(checks, label, value):
    checks.append((label, bool(value)))


def _check_migrate_v24(root):
    path, source = _read(root, os.path.join('sdcc', 'sdcc', 'common', 'db', 'migrations', 'migrate_V24.py'))
    module = ast.parse(source, filename=path)
    checks = []

    func = _find_function_in_module(module, 'migrate_cddos_2113')
    _assert_true(checks, 'migrate_cddos_2113 exists', func is not None)
    if not func:
        return checks

    func_text = _node_text(source, func)

    # The bug: an unconditional $set of fail_over=None anywhere inside an _update_one call.
    # Use DOTALL-friendly multiline match.
    _assert_not_contains(
        checks,
        "BUG ABSENT: existing-zone update does not unconditionally set fail_over: None",
        func_text,
        r"_update_one.*?\$set.*?['\"]fail_over['\"]\s*:\s*None",
    )

    # The fix should be conditional on the current value.
    _assert_contains(
        checks,
        "FIX: fail_over is only cleared when existing zone already has fail_over set (conditional guard present)",
        func_text,
        r"attack_zone\.get\s*\(\s*['\"]fail_over['\"]\s*\)\s*is\s*not\s*None"
        r"|['\"]fail_over['\"]\s*not\s*in\s*attack_zone"
        r"|\$setOnInsert",
    )

    # Migration must still insert the zone for new deployments.
    _assert_contains(
        checks,
        'New-deployment insert path still creates the zone',
        func_text,
        r'_insert_one\s*\(\s*db\.DPZones',
    )

    return checks


def main():
    parser = argparse.ArgumentParser(description='CDDOS-2426 source contract check.')
    parser.add_argument('--root', default=_repo_root())
    args = parser.parse_args()

    checks = _check_migrate_v24(args.root)
    failed = [(label, ok) for label, ok in checks if not ok]

    for label, ok in checks:
        print('[{0}] {1}'.format('OK' if ok else 'FAIL', label))

    if failed:
        print(
            '\n{0} check(s) failed — CDDOS-2426 bug is still present.'.format(len(failed)),
            file=sys.stderr,
        )
        return 1

    print('\nAll CDDOS-2426 checks passed — bug is fixed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
