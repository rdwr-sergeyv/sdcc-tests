#!/usr/bin/env python3
"""Verify DP Isolate contracts for Jira tasks marked progress:testing.

These checks intentionally avoid importing Django/SDCC modules. They validate
the cross-repo source contracts that can be checked reliably from the umbrella
workspace before a live legacy portal/API verification pass is available.
"""

import argparse
import ast
import os
import re
import sys
import warnings


PROGRESS_TESTING_DOCS = (
    'docs/tasks/dp-isolate/JIRA/CDDOS-2113/CDDOS-2274/README.md',
    'docs/tasks/dp-isolate/JIRA/CDDOS-2113/CDDOS-2274/CDDOS-2369.md',
    'docs/tasks/dp-isolate/JIRA/CDDOS-2113/CDDOS-2274/CDDOS-2370.md',
    'docs/tasks/dp-isolate/JIRA/CDDOS-2113/CDDOS-2274/CDDOS-2371.md',
    'docs/tasks/dp-isolate/JIRA/CDDOS-2113/CDDOS-2275.md',
    'docs/tasks/dp-isolate/JIRA/CDDOS-2113/CDDOS-2277.md',
)


def _repo_root():
    current = os.path.abspath(os.path.dirname(__file__))
    for _ in range(4):
        current = os.path.dirname(current)
    return current


def _read(root, relative_path):
    path = os.path.join(root, relative_path)
    with open(path, 'r', encoding='utf-8') as handle:
        return path, handle.read()


def _parse(root, relative_path):
    path, source = _read(root, relative_path)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', SyntaxWarning)
        module = ast.parse(source, filename=path)
    return path, source, module


def _find_class(module, name):
    return next((node for node in module.body if isinstance(node, ast.ClassDef) and node.name == name), None)


def _find_function(node, name):
    body = getattr(node, 'body', [])
    return next((child for child in body if isinstance(child, ast.FunctionDef) and child.name == name), None)


def _find_module_function(module, name):
    return next((node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == name), None)


def _node_text(source, node):
    return ast.get_source_segment(source, node) or ''


def _assert_true(checks, task, label, value):
    checks.append((task, label, bool(value)))


def _assert_contains(checks, task, label, text, pattern):
    matched = re.search(pattern, text, flags=re.MULTILINE | re.DOTALL) is not None
    checks.append((task, label, matched))


def _check_task_docs(root):
    checks = []
    for relative_path in PROGRESS_TESTING_DOCS:
        _, source = _read(root, relative_path)
        key = os.path.splitext(os.path.basename(relative_path))[0]
        if key == 'README':
            key = 'CDDOS-2274'
        _assert_contains(
            checks,
            key,
            '{0} has progress:testing label'.format(relative_path),
            source,
            r'progress_label:\s*progress:testing|progress label:\s*`?progress:testing`?',
        )
    return checks


def _check_enable_contract(root):
    checks = []
    _, incident_source, incident_module = _parse(
        root, os.path.join('sdcc-portal', 'sdcc_portal', 'portal', 'api', 'incident.py'))
    _, enum_source, _ = _parse(
        root, os.path.join('sdcc', 'sdcc', 'common', 'diversion_tasks', 'enums.py'))
    _, documents_source, _ = _parse(
        root, os.path.join('sdcc', 'sdcc', 'common', 'model', 'documents.py'))
    _, diversion_source, diversion_module = _parse(
        root, os.path.join('sdcc', 'sdcc', 'common', 'util', 'diversion.py'))

    handler = _find_class(incident_module, 'IsolateIncidentHandler')
    _assert_true(checks, 'CDDOS-2370', 'IsolateIncidentHandler exists', handler is not None)
    create_text = _node_text(incident_source, _find_function(handler, 'create')) if handler else ''
    handler_text = _node_text(incident_source, handler) if handler else ''

    _assert_contains(checks, 'CDDOS-2370', 'Enable handler allows POST only', handler_text,
                     r"allowed_methods\s*=\s*\(\s*['\"]POST['\"]\s*,?\s*\)")
    _assert_contains(checks, 'CDDOS-2370', 'Enable uses diversion permission decorator', handler_text,
                     r"is_action_permitted\(\[PERMISSIONS\[['\"]DIVERSIONS['\"]\]\],\s*['\"]Incidents['\"]\)")
    _assert_contains(checks, 'CDDOS-2370', 'Enable requires operator role', handler_text,
                     r"require_operator_role")
    _assert_contains(checks, 'CDDOS-2370', 'Enable missing active incident is OK no-op', create_text,
                     r"find_one\(\{['\"]asset['\"].*['\"]endedAt['\"]:\s*None\}\).*HttpResponse\(\{['\"]reply['\"]:\s*['\"]OK['\"]\}")
    _assert_contains(checks, 'CDDOS-2370', 'Enable Attack Zone account is OK no-op', create_text,
                     r"account\.get\(['\"]zone['\"]\)\s*==\s*attack_zone_id")
    _assert_contains(checks, 'CDDOS-2370', 'Enable already isolated incident is OK no-op', create_text,
                     r"isolation_state.*isolated")
    _assert_contains(checks, 'CDDOS-2370', 'Enable in-queue incident returns 409', create_text,
                     r"in_queue.*ErrorRestResult\(.*409")
    _assert_contains(checks, 'CDDOS-2370', 'Enable preflights eligibility before lock', create_text,
                     r"validate_isolation_possible\(self\._db,\s*incident,\s*attack_zone_id=attack_zone_id\).*MongoLock")
    _assert_contains(checks, 'CDDOS-2370', 'Enable lock contention returns 409', create_text,
                     r"lock\(str\(asset_id\).*ErrorRestResult\(.*409")
    _assert_contains(checks, 'CDDOS-2370', 'Isolation trigger enum defines strict API values', enum_source,
                     r"class\s+ISOLATION_TRIGGER\(Enum\):.*MANUAL\s*=\s*['\"]manual['\"].*AUTOMATIC\s*=\s*['\"]automatic['\"]")
    _assert_contains(checks, 'CDDOS-2370', 'Isolation state stores trigger enum values only', documents_source,
                     r"trigger\s*=\s*StringField\(.*choices\s*=\s*ISOLATION_TRIGGER\.values\(\)")
    _assert_contains(checks, 'CDDOS-2370', 'Enable validates trigger against enum values', create_text,
                     r"trigger_source\s+not\s+in\s+ISOLATION_TRIGGER.*ErrorRestResult\(.*400")
    _assert_contains(checks, 'CDDOS-2370', 'Enable maps isolation errors through status helper', create_text,
                     r"except\s+IsolationError\s+as\s+err:.*ErrorRestResult\(err,\s*get_isolation_error_status\(err\)\)")
    _assert_contains(checks, 'CDDOS-2370', 'Enable route is registered', incident_source,
                     r"re_path\(r'\^isolation/enable/.*ErrorHandlingResource\(IsolateIncidentHandler\)")

    validate = _find_module_function(diversion_module, 'validate_isolation_possible')
    isolate = _find_module_function(diversion_module, 'isolate_incident')
    validate_text = _node_text(diversion_source, validate) if validate else ''
    isolate_text = _node_text(diversion_source, isolate) if isolate else ''
    _assert_true(checks, 'CDDOS-2369', 'validate_isolation_possible exists', validate is not None)
    _assert_true(checks, 'CDDOS-2369', 'isolate_incident exists', isolate is not None)
    _assert_contains(checks, 'CDDOS-2369', 'Enable quorum failure raises IsolationNotPossible', validate_text,
                     r"len\(reserved_dps\)\s*<\s*MINIMUM_DPS_FOR_ISOLATION.*raise\s+IsolationNotPossible")
    _assert_contains(checks, 'CDDOS-2369', 'Enable snapshots original selected DPs', isolate_text,
                     r"original_selected_dp_ids")
    _assert_contains(checks, 'CDDOS-2369', 'Enable rebuilds topology for Attack Zone', isolate_text,
                     r"_build_isolation_topology_for_diversion\(db,\s*diversion,\s*attack_zone_id\)")
    _assert_contains(checks, 'CDDOS-2369', 'Enable update uses TASK_ACTION.UPDATE', isolate_text,
                     r"['\"]action['\"]:\s*TASK_ACTION\.UPDATE")
    _assert_contains(checks, 'CDDOS-2369', 'Enable persists isolated audit state', isolate_text,
                     r"IsolationState\(.*isolated\s*=\s*True.*trigger\s*=\s*trigger_source")
    _assert_contains(checks, 'CDDOS-2371', 'Enable excludes deactivated diversions from validation', validate_text,
                     r"_get_active_diversions\(incident\)")
    _assert_contains(checks, 'CDDOS-2371', 'Enable excludes deactivated diversions from update topology', isolate_text,
                     r"active_diversions\s*=\s*_get_active_diversions\(incident\).*for diversion in active_diversions")
    return checks


def _check_disable_contract(root):
    checks = []
    _, incident_source, incident_module = _parse(
        root, os.path.join('sdcc-portal', 'sdcc_portal', 'portal', 'api', 'incident.py'))
    _, diversion_source, diversion_module = _parse(
        root, os.path.join('sdcc', 'sdcc', 'common', 'util', 'diversion.py'))

    handler = _find_class(incident_module, 'RollbackIsolationHandler')
    _assert_true(checks, 'CDDOS-2275', 'RollbackIsolationHandler exists', handler is not None)
    create_text = _node_text(incident_source, _find_function(handler, 'create')) if handler else ''
    handler_text = _node_text(incident_source, handler) if handler else ''

    _assert_contains(checks, 'CDDOS-2275', 'Rollback handler allows POST only', handler_text,
                     r"allowed_methods\s*=\s*\(\s*['\"]POST['\"]\s*,?\s*\)")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback uses diversion permission decorator', handler_text,
                     r"is_action_permitted\(\[PERMISSIONS\[['\"]DIVERSIONS['\"]\]\],\s*['\"]Incidents['\"]\)")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback requires operator role', handler_text,
                     r"require_operator_role")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback missing active incident is OK no-op', create_text,
                     r"find_one\(\{['\"]asset['\"].*['\"]endedAt['\"]:\s*None\}\).*HttpResponse\(\{['\"]reply['\"]:\s*['\"]OK['\"]\}")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback Attack Zone account is OK no-op', create_text,
                     r"account\.get\(['\"]zone['\"]\)\s*==\s*attack_zone_id")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback not-isolated incident without Attack Zone diversion is OK no-op', create_text,
                     r"if\s+not\s+is_isolated\s+and\s+not\s+has_attack_zone_diversion\s*:\s*return\s+HttpResponse")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback in-queue incident returns 409', create_text,
                     r"in_queue.*ErrorRestResult\(.*409")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback uses asset-level MongoLock', create_text,
                     r"MongoLock\(client=self\._db\.client\).*lock\(str\(asset_id\)")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback lock contention returns 409', create_text,
                     r"lock\(str\(asset_id\).*ErrorRestResult\(.*409")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback success calls rollback_isolation', create_text,
                     r"rollback_isolation\(self\._db,\s*self\._db_stats,\s*incident,\s*account\)")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback lock is released in finally', create_text,
                     r"finally:.*release\(str\(asset_id\),\s*lock_owner\)")
    _assert_contains(checks, 'CDDOS-2275', 'Disable route is registered', incident_source,
                     r"re_path\(r'\^isolation/disable/.*ErrorHandlingResource\(RollbackIsolationHandler\)")

    build = _find_module_function(diversion_module, 'build_rollback_topology')
    rollback = _find_module_function(diversion_module, 'rollback_isolation')
    build_text = _node_text(diversion_source, build) if build else ''
    rollback_text = _node_text(diversion_source, rollback) if rollback else ''
    _assert_true(checks, 'CDDOS-2275', 'build_rollback_topology exists', build is not None)
    _assert_true(checks, 'CDDOS-2275', 'rollback_isolation exists', rollback is not None)
    _assert_contains(checks, 'CDDOS-2275', 'Rollback reads original selected DP snapshot', build_text,
                     r"original_selected_dp_ids")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback filters snapshot devices by account zone', build_text,
                     r"_get_available_snapshot_dps\(db,\s*sc_id,\s*snapshot_dp_ids,\s*account_zone_id\)")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback refills missing slots best-effort', build_text,
                     r"_get_reserved_rollback_dps\(db,\s*diversion,\s*account_zone_id,\s*selected_dp_id_set\)")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback topology writes account zone', build_text,
                     r"['\"]zone['\"]:\s*account_zone_id")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback update uses TASK_ACTION.UPDATE', rollback_text,
                     r"['\"]action['\"]:\s*TASK_ACTION\.UPDATE")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback clears original selected DP snapshots', rollback_text,
                     r"original_selected_dp_ids['\"]\]\s*=\s*\[\]")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback marks incident not isolated', rollback_text,
                     r"isolation_state\.isolated\s*=\s*False")
    _assert_contains(checks, 'CDDOS-2275', 'Rollback sets rollback_at', rollback_text,
                     r"isolation_state\.rollback_at\s*=")
    return checks


def _check_isolated_update_contract(root):
    checks = []
    _, diversion_source, diversion_module = _parse(
        root, os.path.join('sdcc', 'sdcc', 'common', 'util', 'diversion.py'))

    parse_action = _find_module_function(diversion_module, '_parse_action_args')
    validate_dps = _find_module_function(diversion_module, 'validate_dps_if_dp_changed')
    check_validation = _find_module_function(diversion_module, 'check_validation_of_dps')
    update_template = _find_module_function(diversion_module, 'update_selected_dps_in_template')
    parse_text = _node_text(diversion_source, parse_action) if parse_action else ''
    validate_text = _node_text(diversion_source, validate_dps) if validate_dps else ''
    check_text = _node_text(diversion_source, check_validation) if check_validation else ''
    template_text = _node_text(diversion_source, update_template) if update_template else ''

    _assert_true(checks, 'CDDOS-2277', '_parse_action_args exists', parse_action is not None)
    _assert_true(checks, 'CDDOS-2277', 'validate_dps_if_dp_changed exists', validate_dps is not None)
    _assert_true(checks, 'CDDOS-2277', 'check_validation_of_dps exists', check_validation is not None)
    _assert_true(checks, 'CDDOS-2277', 'update_selected_dps_in_template accepts effective_zone',
                 update_template is not None and any(arg.arg == 'effective_zone' for arg in update_template.args.args))
    _assert_contains(checks, 'CDDOS-2277', 'Manual isolated updates force args zone to Attack Zone', parse_text,
                     r"if\s+_is_incident_isolated\(incident\)\s+and\s+not\s+data\.get\(['\"]rollback_isolation['\"]\):.*args\[['\"]zone['\"]\]\s*=\s*_get_attack_zone_id\(db\)")
    _assert_contains(checks, 'CDDOS-2277', 'Manual isolated updates overwrite request topology zone', parse_text,
                     r"data_topology\[['\"]zone['\"]\]\s*=\s*args\[['\"]zone['\"]\]")
    _assert_contains(checks, 'CDDOS-2277', 'DP-change validation uses Attack Zone while isolated', check_text,
                     r"effective_zone\s*=\s*_get_attack_zone_id\(db\)\s*if\s*_is_incident_isolated\(incident\)\s*else\s*account\.get\(['\"]zone['\"]\)")
    _assert_contains(checks, 'CDDOS-2277', 'DP fallback template receives effective zone', check_text,
                     r"update_selected_dps_in_template\(db,\s*\[requested_topology\].*effective_zone=effective_zone")
    _assert_contains(checks, 'CDDOS-2277', 'Template selection uses effective zone over account zone', template_text,
                     r"selected_base_zone\s*=\s*effective_zone\s*if\s*effective_zone\s+is\s+not\s+None\s+else\s+incident_account\.get\(['\"]zone['\"]\)")
    _assert_contains(checks, 'CDDOS-2277', 'Validation detects additional SC with changed DP set', validate_text,
                     r"diversion_in_old_topology.*if\s+diversion_in_old_topology:")
    return checks


def main():
    parser = argparse.ArgumentParser(description='Verify local DP Isolate progress:testing contracts.')
    parser.add_argument('--root', default=_repo_root(), help='Umbrella repository root.')
    args = parser.parse_args()

    all_checks = []
    all_checks.extend(_check_task_docs(args.root))
    all_checks.extend(_check_enable_contract(args.root))
    all_checks.extend(_check_disable_contract(args.root))
    all_checks.extend(_check_isolated_update_contract(args.root))

    failed = [(task, label) for task, label, ok in all_checks if not ok]
    for task, label, ok in all_checks:
        print('[{0}] {1}: {2}'.format('OK' if ok else 'FAIL', task, label))

    if failed:
        print('\n{0} progress-testing contract check(s) failed.'.format(len(failed)), file=sys.stderr)
        return 1

    print('\nAll DP Isolate progress:testing source contract checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
