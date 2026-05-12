#!/usr/bin/env python3
"""CDDOS-2427 — Source contract check: IsolateIncidentHandler must not use first-diversion-only zone check.

This check FAILS on the current buggy code (which reads diversion[0].zone) and
PASSES once the fix either removes the secondary guard or replaces it with an
all-diversions check.

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


def _find_class(module, name):
    for node in module.body:
        if isinstance(node, ast.ClassDef) and node.name == name:
            return node
    return None


def _find_function(node, name):
    for child in node.body:
        if isinstance(child, ast.FunctionDef) and child.name == name:
            return child
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


def _check_incident_py(root):
    path, source = _read(root, os.path.join('sdcc-portal', 'sdcc_portal', 'portal', 'api', 'incident.py'))
    module = ast.parse(source, filename=path)
    checks = []

    handler = _find_class(module, 'IsolateIncidentHandler')
    _assert_true(checks, 'IsolateIncidentHandler exists', handler is not None)
    if not handler:
        return checks

    create = _find_function(handler, 'create')
    _assert_true(checks, 'create method exists', create is not None)
    if not create:
        return checks

    create_text = _node_text(source, create)

    # The bug: indexing into diversion[0] or 'diversion', [None])[0] to get the zone.
    _assert_not_contains(
        checks,
        "BUG ABSENT: create() does not read only first_diversion zone via index [0]",
        create_text,
        r"diversion.*\[.*(?:0|None).*\]\s*\[?\s*0?\s*\]?.*\.get\s*\(\s*['\"]zone['\"]\s*\)\s*==\s*attack_zone_id"
        r"|first_diversion\s*=\s*incident\.get\(",
    )

    # After the fix: the first_diversion single-index pattern must be gone.
    # Either the secondary guard is removed entirely or replaced with an all() check.
    _assert_not_contains(
        checks,
        "FIX: first_diversion single-index zone check is removed",
        create_text,
        r"first_diversion\s*=\s*incident\.get\s*\(",
    )

    # Primary guard must still be there.
    _assert_contains(
        checks,
        'Primary isolation_state.isolated guard is still present',
        create_text,
        r"isolation_state.*isolated",
    )

    return checks


def main():
    parser = argparse.ArgumentParser(description='CDDOS-2427 source contract check.')
    parser.add_argument('--root', default=_repo_root())
    args = parser.parse_args()

    checks = _check_incident_py(args.root)
    failed = [(label, ok) for label, ok in checks if not ok]

    for label, ok in checks:
        print('[{0}] {1}'.format('OK' if ok else 'FAIL', label))

    if failed:
        print(
            '\n{0} check(s) failed — CDDOS-2427 bug is still present.'.format(len(failed)),
            file=sys.stderr,
        )
        return 1

    print('\nAll CDDOS-2427 checks passed — bug is fixed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
