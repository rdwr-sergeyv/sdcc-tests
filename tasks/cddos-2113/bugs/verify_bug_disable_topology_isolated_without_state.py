#!/usr/bin/env python3
"""Source contract check: disable must not no-op when topology is in Attack Zone but isolation_state is missing.

This check FAILS on the current buggy code, where RollbackIsolationHandler only
looks at incident.isolation_state.isolated. If an earlier enable path returned
OK based on diversion[0].zone without setting isolation_state, disable returns
OK and leaves the Attack Zone topology in place.

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
    checks.append((label, re.search(pattern, text, flags=re.MULTILINE | re.DOTALL) is not None))


def _assert_not_contains(checks, label, text, pattern):
    checks.append((label, re.search(pattern, text, flags=re.MULTILINE | re.DOTALL) is None))


def _assert_true(checks, label, value):
    checks.append((label, bool(value)))


def _check_incident_py(root):
    path, source = _read(root, os.path.join('sdcc-portal', 'sdcc_portal', 'portal', 'api', 'incident.py'))
    module = ast.parse(source, filename=path)
    checks = []

    handler = _find_class(module, 'RollbackIsolationHandler')
    _assert_true(checks, 'RollbackIsolationHandler exists', handler is not None)
    if not handler:
        return checks

    create = _find_function(handler, 'create')
    _assert_true(checks, 'create method exists', create is not None)
    if not create:
        return checks

    create_text = _node_text(source, create)

    _assert_contains(
        checks,
        'rollback still reads isolation_state.isolated',
        create_text,
        r'isolation_state.*isolated',
    )
    _assert_contains(
        checks,
        'FIX: rollback also checks diversion zones against attack_zone_id',
        create_text,
        r'diversion.*zone|zone.*attack_zone_id|attack_zone_id.*zone',
    )
    _assert_not_contains(
        checks,
        'BUG ABSENT: rollback no longer no-ops solely on missing isolation_state.isolated',
        create_text,
        r"if\s+not\s+\(incident\.get\(\s*['\"]isolation_state['\"]\s*\)\s+or\s+\{\}\)\.get\(\s*['\"]isolated['\"]\s*\)\s*:\s*return\s+HttpResponse\(\{'reply':\s*'OK'\}",
    )

    return checks


def main():
    parser = argparse.ArgumentParser(description='Rollback topology-isolated-without-state source contract check.')
    parser.add_argument('--root', default=_repo_root())
    args = parser.parse_args()

    checks = _check_incident_py(args.root)
    failed = [(label, ok) for label, ok in checks if not ok]

    for label, ok in checks:
        print('[{0}] {1}'.format('OK' if ok else 'FAIL', label))

    if failed:
        print(
            '\n{0} check(s) failed - disable can still no-op when only topology indicates isolation.'.format(
                len(failed)
            ),
            file=sys.stderr,
        )
        return 1

    print('\nAll rollback topology-isolated-without-state checks passed - bug is fixed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
