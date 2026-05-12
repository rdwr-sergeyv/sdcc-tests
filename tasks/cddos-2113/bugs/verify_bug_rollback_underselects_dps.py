#!/usr/bin/env python3
"""Source contract check: rollback must fail if it cannot restore/refill enough DPs.

This check FAILS on the current buggy code, where build_rollback_topology()
best-effort refills missing DPs but still returns a topology when the final
selected DP count is below the intended target.

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


def _find_function(module, name):
    for node in ast.walk(module):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    return None


def _node_text(source, node):
    return ast.get_source_segment(source, node) or ''


def _assert_contains(checks, label, text, pattern):
    checks.append((label, re.search(pattern, text, flags=re.MULTILINE | re.DOTALL) is not None))


def _assert_true(checks, label, value):
    checks.append((label, bool(value)))


def _check_diversion_py(root):
    path, source = _read(root, os.path.join('sdcc', 'sdcc', 'common', 'util', 'diversion.py'))
    module = ast.parse(source, filename=path)
    checks = []

    func = _find_function(module, 'build_rollback_topology')
    _assert_true(checks, 'build_rollback_topology exists', func is not None)
    if not func:
        return checks

    func_text = _node_text(source, func)

    _assert_contains(
        checks,
        'rollback computes the intended selected DP count',
        func_text,
        r'target_dp_count\s*=',
    )
    _assert_contains(
        checks,
        'FIX: rollback checks final selected DP count against target count',
        func_text,
        r'len\s*\(\s*selected_dp_ids\s*\)\s*<\s*target_dp_count',
    )
    _assert_contains(
        checks,
        'FIX: rollback raises a controlled isolation error when selected DPs are insufficient',
        func_text,
        r'raise\s+(?:IsolationNotPossible|IsolationError|ValueError)',
    )

    return checks


def main():
    parser = argparse.ArgumentParser(description='Rollback under-selected DP source contract check.')
    parser.add_argument('--root', default=_repo_root())
    args = parser.parse_args()

    checks = _check_diversion_py(args.root)
    failed = [(label, ok) for label, ok in checks if not ok]

    for label, ok in checks:
        print('[{0}] {1}'.format('OK' if ok else 'FAIL', label))

    if failed:
        print(
            '\n{0} check(s) failed - rollback can still proceed with too few selected DPs.'.format(len(failed)),
            file=sys.stderr,
        )
        return 1

    print('\nAll rollback under-selected DP checks passed - bug is fixed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
