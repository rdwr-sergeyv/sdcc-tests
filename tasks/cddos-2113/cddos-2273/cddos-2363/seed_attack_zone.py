#!/usr/bin/env python3
"""Seed the Attack Zone DPZone record in a local SDCC database.

This is a task helper for CDDOS-2363. It intentionally invokes the production
migration function so ad hoc local seeding and normal migrations use the same
idempotent behavior.
"""

import argparse
import importlib.util
import os
import sys

from pymongo import MongoClient


def _repo_root():
    current = os.path.abspath(os.path.dirname(__file__))
    for _ in range(5):
        current = os.path.dirname(current)
    return current


def _add_sdcc_to_path():
    sdcc_path = os.path.join(_repo_root(), 'sdcc')
    if sdcc_path not in sys.path:
        sys.path.insert(0, sdcc_path)


def _load_migration_function():
    migrate_v24_path = os.path.join(
        _repo_root(), 'sdcc', 'sdcc', 'common', 'db', 'migrations', 'migrate_V24.py'
    )
    spec = importlib.util.spec_from_file_location('migrate_V24', migrate_v24_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.migrate_cddos_2113


def _parse_args():
    parser = argparse.ArgumentParser(description='Seed attack_zone DPZone in a local SDCC database.')
    parser.add_argument('--host', default='127.0.0.1', help='MongoDB host. Default: 127.0.0.1')
    parser.add_argument('--port', default=27017, type=int, help='MongoDB port. Default: 27017')
    parser.add_argument('--db', default='sdcc', help='MongoDB database name. Default: sdcc')
    return parser.parse_args()


def main():
    args = _parse_args()
    _add_sdcc_to_path()

    migrate_cddos_2113 = _load_migration_function()

    client = MongoClient(args.host, args.port)
    db = client[args.db]

    migrate_cddos_2113(db, {'_logger': None})
    attack_zone = db.DPZones.find_one({'name': 'attack_zone'})

    if not attack_zone:
        raise RuntimeError('attack_zone was not created')

    print('attack_zone seeded')
    print('id: {0}'.format(attack_zone.get('_id')))
    print('fail_over: {0}'.format(attack_zone.get('fail_over')))
    print('description: {0}'.format(attack_zone.get('description')))


if __name__ == '__main__':
    main()
