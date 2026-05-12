#!/usr/bin/env python3
"""CDDOS-2425 — Source contract check: _parse_action_args must catch IsolationConfigurationError.

This check FAILS on the current buggy code (no try/except around _get_attack_zone_id) and
PASSES once the fix wraps or guards that call appropriately.

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


def _assert_true(checks, label, value):
    checks.append((label, bool(value)))


def _check_diversion_py(root):
    path, source = _read(root, os.path.join('sdcc', 'sdcc', 'common', 'util', 'diversion.py'))
    module = ast.parse(source, filename=path)
    checks = []

    func = _find_function_in_module(module, '_parse_action_args')
    _assert_true(checks, '_parse_action_args exists', func is not None)
    if not func:
        return checks

    func_text = _node_text(source, func)

    # Confirm the isolated-incident branch still calls _get_attack_zone_id (we're not removing the feature).
    _assert_contains(
        checks,
        '_parse_action_args still calls _get_attack_zone_id for isolated incidents',
        func_text,
        r'_get_attack_zone_id\s*\(\s*db\s*\)',
    )

    # The fix: the call site must be wrapped in a try/except covering IsolationConfigurationError
    # (or IsolationError, which is the base).
    _assert_contains(
        checks,
        'FIX: _get_attack_zone_id call in _parse_action_args is guarded by try/except for IsolationError',
        func_text,
        r'try\s*:.*_get_attack_zone_id\s*\(\s*db\s*\).*except\s+Isolation(?:ConfigurationError|Error)',
    )

    # IsolationConfigurationError must be defined in the module.
    _assert_true(
        checks,
        'IsolationConfigurationError is defined in diversion.py',
        any(
            isinstance(n, ast.ClassDef) and n.name == 'IsolationConfigurationError'
            for n in ast.walk(module)
        ),
    )

    return checks


def main():
    parser = argparse.ArgumentParser(description='CDDOS-2425 source contract check.')
    parser.add_argument('--root', default=_repo_root())
    args = parser.parse_args()

    checks = _check_diversion_py(args.root)
    failed = [(label, ok) for label, ok in checks if not ok]

    for label, ok in checks:
        print('[{0}] {1}'.format('OK' if ok else 'FAIL', label))

    if failed:
        print(
            '\n{0} check(s) failed — CDDOS-2425 bug is still present.'.format(len(failed)),
            file=sys.stderr,
        )
        return 1

    print('\nAll CDDOS-2425 checks passed — bug is fixed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
