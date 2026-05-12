#!/usr/bin/env python3
"""CDDOS-2424 — Source contract check: build_rollback_topology must not include deactivated diversions.

This check FAILS on the current buggy code (which iterates all diversions) and
PASSES once the fix replaces that loop with _get_active_diversions(incident).

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


def _check_diversion_py(root):
    path, source = _read(root, os.path.join('sdcc', 'sdcc', 'common', 'util', 'diversion.py'))
    module = ast.parse(source, filename=path)
    checks = []

    func = _find_function_in_module(module, 'build_rollback_topology')
    _assert_true(checks, 'build_rollback_topology exists', func is not None)
    if not func:
        return checks

    func_text = _node_text(source, func)

    # The fix: the function should filter to active diversions only.
    _assert_contains(
        checks,
        'FIX: build_rollback_topology uses _get_active_diversions (not raw diversion list)',
        func_text,
        r'_get_active_diversions\s*\(\s*incident\s*\)',
    )

    # The bug: iterating all diversions via incident.get('diversion') must be gone.
    _assert_not_contains(
        checks,
        'BUG ABSENT: build_rollback_topology no longer iterates incident.get("diversion") directly',
        func_text,
        r"incident\.get\s*\(\s*['\"]diversion['\"]\s*,\s*\[\s*\]\s*\)",
    )

    # _get_active_diversions must also exist and itself call _is_diversion_deactivated.
    active_div_fn = _find_function_in_module(module, '_get_active_diversions')
    _assert_true(checks, '_get_active_diversions helper exists', active_div_fn is not None)
    if active_div_fn:
        helper_text = _node_text(source, active_div_fn)
        _assert_contains(
            checks,
            '_get_active_diversions delegates to _get_active_diversion_items',
            helper_text,
            r'_get_active_diversion_items',
        )

    return checks


def main():
    parser = argparse.ArgumentParser(description='CDDOS-2424 source contract check.')
    parser.add_argument('--root', default=_repo_root())
    args = parser.parse_args()

    checks = _check_diversion_py(args.root)
    failed = [(label, ok) for label, ok in checks if not ok]

    for label, ok in checks:
        print('[{0}] {1}'.format('OK' if ok else 'FAIL', label))

    if failed:
        print(
            '\n{0} check(s) failed — CDDOS-2424 bug is still present.'.format(len(failed)),
            file=sys.stderr,
        )
        return 1

    print('\nAll CDDOS-2424 checks passed — bug is fixed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
