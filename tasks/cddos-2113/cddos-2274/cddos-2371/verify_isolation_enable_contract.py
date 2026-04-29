#!/usr/bin/env python3
"""Verify the local CDDOS-2371 source contract.

This is a lightweight source-level guard for the legacy repos. It intentionally
avoids importing Django/SDCC modules because those imports require a configured
portal runtime. The live API matrix is still required before closing CDDOS-2371.
"""

import argparse
import ast
import os
import re
import sys


def _repo_root():
    current = os.path.abspath(os.path.dirname(__file__))
    for _ in range(5):
        current = os.path.dirname(current)
    return current


def _read(root, relative_path):
    path = os.path.join(root, relative_path)
    with open(path, 'r', encoding='utf-8') as handle:
        return path, handle.read()


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

    handler_text = _node_text(source, handler)
    create = _find_function(handler, 'create')
    create_text = _node_text(source, create) if create else ''

    _assert_contains(checks, 'Handler allows POST only', handler_text, r"allowed_methods\s*=\s*\(\s*['\"]POST['\"]\s*,?\s*\)")
    _assert_true(checks, 'create(request, resource_id) exists', create is not None)
    _assert_contains(checks, 'Role failure maps to Http403', create_text, r"OPERATOR_ADMIN.*OPERATOR_SUPER.*Http403")
    _assert_contains(checks, 'Missing active incident returns OK no-op', create_text, r"find_one\(\{['\"]asset['\"].*['\"]endedAt['\"]:\s*None\}\).*HttpResponse\(\{['\"]reply['\"]:\s*['\"]OK['\"]\}")
    _assert_contains(checks, 'Attack Zone account returns OK no-op', create_text, r"account\.get\(['\"]zone['\"]\)\s*==\s*attack_zone_id")
    _assert_contains(checks, 'Already-isolated state returns OK no-op', create_text, r"isolation_state.*isolated")
    _assert_contains(checks, 'Already in Attack Zone returns OK no-op', create_text, r"first_diversion.*zone.*attack_zone_id")
    _assert_contains(checks, 'In-queue incident returns 409', create_text, r"in_queue.*ErrorRestResult\(.*409")
    _assert_contains(checks, 'Asset-level MongoLock is used', create_text, r"MongoLock\(client=self\._db\.client\).*lock\(str\(asset_id\)")
    _assert_contains(checks, 'Lock contention returns 409', create_text, r"lock\(str\(asset_id\).*ErrorRestResult\(.*409")
    _assert_contains(checks, 'manual/auto trigger contract exists', create_text, r"request\.data\.get\(['\"]trigger['\"],\s*['\"]manual['\"]\).*manual.*auto")
    _assert_contains(checks, 'IsolationNotPossible maps to 422', create_text, r"except\s+IsolationNotPossible.*ErrorRestResult\(err,\s*422\)")
    _assert_contains(checks, 'Successful request calls isolate_incident', create_text, r"isolate_incident\(self\._db,\s*self\._db_stats,\s*incident,\s*trigger_source=trigger_source\)")
    _assert_contains(checks, 'Lock is released in finally', create_text, r"finally:.*release\(str\(asset_id\),\s*lock_owner\)")
    _assert_contains(checks, 'Enable route is registered', source, r"re_path\(r'\^isolation/enable/.*ErrorHandlingResource\(IsolateIncidentHandler\)")

    return checks


def _check_diversion_py(root):
    path, source = _read(root, os.path.join('sdcc', 'sdcc', 'common', 'util', 'diversion.py'))
    module = ast.parse(source, filename=path)
    checks = []

    _assert_true(checks, 'IsolationNotPossible exists', _find_class(module, 'IsolationNotPossible') is not None)
    _assert_true(checks, 'get_attack_zone exists', any(isinstance(node, ast.FunctionDef) and node.name == 'get_attack_zone' for node in module.body))
    isolate = next((node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'isolate_incident'), None)
    _assert_true(checks, 'isolate_incident exists', isolate is not None)
    if not isolate:
        return checks

    isolate_text = _node_text(source, isolate)
    _assert_contains(checks, 'Quorum failure raises IsolationNotPossible before update', isolate_text, r"len\(reserved_dps\)\s*<\s*MINIMUM_DPS_FOR_ISOLATION.*raise\s+IsolationNotPossible")
    _assert_contains(checks, 'Original selected DPs are snapshotted', isolate_text, r"original_selected_dp_ids")
    _assert_contains(checks, 'Topology is rebuilt for Attack Zone', isolate_text, r"_build_isolation_topology_for_diversion\(db,\s*diversion,\s*attack_zone_id\)")
    _assert_contains(checks, 'Topology update uses TASK_ACTION.UPDATE', isolate_text, r"['\"]action['\"]:\s*TASK_ACTION\.UPDATE")
    _assert_contains(checks, 'update_incident is called', isolate_text, r"update_incident\(data=data,\s*db=db,\s*db_stats=db_stats,\s*incident_id=incident\['_id'\]\)")
    _assert_contains(checks, 'Success writes isolated audit state', isolate_text, r"['\"]isolation_state['\"].*['\"]isolated['\"]:\s*True.*['\"]trigger['\"]:\s*trigger_source")

    return checks


def main():
    parser = argparse.ArgumentParser(description='Verify local CDDOS-2371 source contract.')
    parser.add_argument('--root', default=_repo_root(), help='Umbrella repository root.')
    args = parser.parse_args()

    all_checks = _check_incident_py(args.root) + _check_diversion_py(args.root)
    failed = [(label, ok) for label, ok in all_checks if not ok]

    for label, ok in all_checks:
        print('[{0}] {1}'.format('OK' if ok else 'FAIL', label))

    if failed:
        print('\n{0} contract check(s) failed.'.format(len(failed)), file=sys.stderr)
        return 1

    print('\nAll CDDOS-2371 source contract checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
