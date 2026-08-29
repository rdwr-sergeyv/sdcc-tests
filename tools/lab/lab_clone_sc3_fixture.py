#!/usr/bin/env python3
"""lab_clone_sc3_fixture.py -- give NEW_SC (SC3) a working fabric by CLONING, not moving.

DRY-RUN BY DEFAULT. Pass --apply to write.

WHAT THIS BUILDS
    The three-SC fixture of docs/tasks/escalate/Lab-3SC-Scenario.md 4b: two standard SCs mapped to
    one Escalation SC, so escalation's many-to-one case can be exercised at all. Today exactly one SC
    maps to NEW-LAB, so every escalate ever run has been one-to-one.

WHY CLONE AND NOT MOVE
    Section 4 of that design moves two default-zone DefensePros out of NEW-LAB-2. That works and it
    costs: NEW-LAB-2 drops from four wired default DPs to two, every render baseline captured against
    it changes, and a DP moved without its router-out interfaces silently vanishes from `metrics` --
    CSP-969's shape, already paid for once.

    Cloning costs none of that, and it is not an invention: the lab ALREADY runs one physical access
    router as two device documents. LAB-AR-3 (10.20.7.201) and LAB-AR-4 (10.20.7.202) each exist
    twice, once in NEW-LAB and once in NEW-LAB-2, with distinct unique_ids. This does the same for
    SC3. Nothing moves, so no account, site, asset, tunnel, task or incident changes owner.

THE CONSTRAINT THIS BUYS -- READ IT
    Cloning means two scrubbing centres each believe they own the same physical DefensePro. Under
    SDCC_TASK_TYPE=build -- the lab default, and what every one of these suites uses -- nothing is
    pushed to a device, so the overlap exists only on paper. Under `provisioning` it is a genuine
    double-configuration of one box.

    **This fixture is safe only while the lab stays build-only.** That is a property of the lab, not
    of this script, and it belongs in the profile rather than in someone's memory.

WHAT IS DELIBERATELY NOT USED
    SC3's own router-out, `ROut1`, is a **Cisco** ASR 1000 with zero interfaces. The announcement
    templates (ro_add_community_asset) are Junos, and the generic template IS the Juniper one because
    production runs Juniper only -- so a Cisco access router would render Junos syntax at a device
    that cannot take it. ROut1 is left untouched and unused; removing it is a separate decision.

NAMING
    The clones are named SC3-* rather than reusing LAB-AR-3 / LAB4-DP-1. Device names already repeat
    across SCs in this lab and that has produced a wrong answer at least once -- a site read as
    4-of-5 tunnels healthy when all five were unusable, because the check matched a same-named router
    in the other SC. The IP says which physical box; the name says which SC's document you are
    looking at.

    SC3-DP-1  10.14.195.101  = the same box as NEW-LAB-2/LAB4-DP-1
    SC3-DP-2  10.14.195.102  = the same box as NEW-LAB-2/LAB4-DP-2
    SC3-AR-3  10.20.7.201    = the same box as LAB-AR-3 (already twice over)
    SC3-AR-4  10.20.7.202    = the same box as LAB-AR-4 (already twice over)

IDEMPOTENT: every step checks its own precondition by device name, so a second run writes nothing.
It exits rather than guess whenever the state is neither the before nor the after it expects.

    docker cp tools/lab_clone_sc3_fixture.py legacy-portal-portal-1:/tmp/clone_sc3.py
    docker exec legacy-portal-portal-1 python /tmp/clone_sc3.py           # dry run
    docker exec legacy-portal-portal-1 python /tmp/clone_sc3.py --apply

Run tools/lab_validate.py before and after -- that is the acceptance test.
"""
import argparse
import copy
import os
import sys

from bson import ObjectId
from pymongo import MongoClient

SC3 = 'NEW_SC'
ESCALATION_SC = 'NEW-LAB'
SOURCE_SC = 'NEW-LAB-2'

# Cloned DPs: (source device in SOURCE_SC, new name, VLAN for its AR interfaces).
# VLANs 20 and 21 are outside the in-use set measured 2026-08-23:
# 0, 10, 11, 50, 51, 60, 61, 70, 71, 100, 101, 111, 555, 777.
DP_CLONES = [
    ('LAB4-DP-1', 'SC3-DP-1', 20),
    ('LAB4-DP-2', 'SC3-DP-2', 21),
]

# Cloned access routers: (source device, new name, community_tag_sequence, abbreviation, host octet).
# The host octet follows the lab's own convention, measured on NEW-LAB-2: .101 is the AR-3 side of a
# next hop, .105 the AR-4 side. community_tag_sequence is NOT globally unique -- SCRUBBING_1's
# Router_OUT_1 and NEW-LAB-2's LAB-AR-3 both hold 3 -- so only distinctness WITHIN SC3 is required,
# and SC3's existing ROut1 holds 2.
AR_CLONES = [
    ('LAB-AR-3', 'SC3-AR-3', 5, 'S33', 101),
    ('LAB-AR-4', 'SC3-AR-4', 6, 'S34', 105),
]

DEFAULT_ZONE_NAME = 'default'


def die(msg):
    sys.exit('REFUSING: %s' % msg)


def sc_by_name(db, name):
    sc = db.ScrubbingCenters.find_one({'name': name})
    if sc is None:
        die('no scrubbing center named %r' % name)
    return sc


def device(sc, name):
    for d in sc.get('management_devices') or []:
        if d.get('name') == name:
            return d
    return None


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('--apply', action='store_true', help='write; without it nothing is changed')
    args = p.parse_args()
    db = MongoClient(os.environ.get('SDCC_MONGO_HOST', 'localhost'),
                     int(os.environ.get('SDCC_MONGO_PORT', 27017)),
                     directConnection=True)[os.environ.get('SDCC_MONGO_DB', 'sdcc')]

    print('lab_clone_sc3_fixture -- %s\n'
          % ('APPLYING' if args.apply else 'DRY RUN (pass --apply to write)'))

    # ---------------------------------------------------------------- preflight
    print('0. preflight')
    busy = db.Tasks.count_documents({'status': {'$in': ['in_queue', 'pending', 'in_progress']}})
    queued = db.Incidents.count_documents({'in_queue': True, 'endedAt': None})
    if busy or queued:
        die('%d task(s) in flight and %d queued incident(s). Nothing may be mutated while device '
            'work is outstanding.' % (busy, queued))
    print('   ok     nothing in flight (0 busy tasks, 0 queued incidents)')

    sc3 = sc_by_name(db, SC3)
    src = sc_by_name(db, SOURCE_SC)
    esc = sc_by_name(db, ESCALATION_SC)
    if esc.get('sc_type') != 'escalation':
        die('%s is not an Escalation SC (sc_type=%r); the mapping would be invalid'
            % (ESCALATION_SC, esc.get('sc_type')))
    if sc3.get('sc_type') == 'escalation':
        die('%s is itself an Escalation SC; it cannot escalate onwards' % SC3)
    print('   ok     %s is the Escalation SC, %s may map to it' % (ESCALATION_SC, SC3))

    zone = db.DPZones.find_one({'name': DEFAULT_ZONE_NAME})
    if zone is None:
        die('no DPZone named %r' % DEFAULT_ZONE_NAME)

    router_in = next((d for d in (sc3.get('management_devices') or [])
                      if d.get('role') == 'router-in'), None)
    if router_in is None:
        die('%s has no router-in; a cloned DP has nothing to reference' % SC3)
    print('   ok     %s router-in is %s (%s)' % (SC3, router_in.get('name'), router_in.get('ip')))

    changes = noops = 0

    # ---------------------------------------------------------------- 1. the mapping
    print('\n1. map %s -> %s' % (SC3, ESCALATION_SC))
    if sc3.get('escalates_to') == esc['_id']:
        print('   ok     already mapped'); noops += 1
    elif sc3.get('escalates_to'):
        die('%s already escalates to something else (%s)' % (SC3, sc3.get('escalates_to')))
    else:
        print('   CHANGE escalates_to = %s' % esc['_id']); changes += 1
        if args.apply:
            db.ScrubbingCenters.update_one({'_id': sc3['_id']},
                                           {'$set': {'escalates_to': esc['_id']}})

    # ---------------------------------------------------------------- 2/3. the clones
    # DPs reference AR uids and ARs reference DP uids, so every id is minted first and both sides are
    # written already consistent. Doing it in two passes would leave a window where one side dangles.
    print('\n2. clone %d DefensePro(s) and %d access router(s) into %s'
          % (len(DP_CLONES), len(AR_CLONES), SC3))

    existing = [n for _s, n, _v in DP_CLONES if device(sc3, n)] + \
               [n for _s, n, _c, _a, _o in AR_CLONES if device(sc3, n)]
    wanted = [n for _s, n, _v in DP_CLONES] + [n for _s, n, _c, _a, _o in AR_CLONES]
    if existing and sorted(existing) != sorted(wanted):
        die('%s already holds SOME of the clones (%s) but not all of %s -- a half-built fixture is '
            'not something to guess at' % (SC3, ', '.join(sorted(existing)), ', '.join(sorted(wanted))))

    if existing:
        print('   ok     all %d clone(s) already present' % len(wanted)); noops += len(wanted)
    else:
        dp_uid = {new: ObjectId() for _s, new, _v in DP_CLONES}
        ar_uid = {new: ObjectId() for _s, new, _c, _a, _o in AR_CLONES}
        new_devices, new_status = [], []

        for source_name, new_name, vlan in DP_CLONES:
            source = device(src, source_name)
            if source is None:
                die('%s has no DP named %r to clone' % (SOURCE_SC, source_name))
            d = copy.deepcopy(source)
            d['unique_id'] = dp_uid[new_name]
            d['name'] = new_name
            d['zone'] = zone['_id']
            d['abbreviation'] = new_name[-5:]
            # The DP's own interfaces name the routers it sits between -- point them at SC3's, not
            # the source SC's, or the clone silently references another SC's devices.
            src_ifaces = source.get('interfaces') or []
            d['interfaces'] = []
            for idx, (_s, ar_name, _c, _a, _o) in enumerate(AR_CLONES):
                proto = src_ifaces[idx] if idx < len(src_ifaces) else (src_ifaces[0] if src_ifaces else {})
                d['interfaces'].append({
                    'ifIndex': proto.get('ifIndex', '8'),
                    'pairIndex': proto.get('pairIndex', '9'),
                    'router_in': router_in['unique_id'],
                    'router_out': ar_uid[ar_name],
                })
            new_devices.append(d)
            print('   CHANGE DP  %-10s ip=%-15s zone=%s  (same box as %s/%s)'
                  % (new_name, d.get('ip'), DEFAULT_ZONE_NAME, SOURCE_SC, source_name))

            # Without its own status row the DP reads as version-less, exactly as SCRUBBING_1's do.
            st = db.ScrubbingCenterDeviceStatuses.find_one({'_id.device_uid': source['unique_id']})
            if st is not None:
                row = copy.deepcopy(st)
                row['_id'] = dict(row['_id'])
                row['_id']['scrubbing_center'] = sc3['_id']
                row['_id']['device_uid'] = dp_uid[new_name]
                new_status.append(row)

        for source_name, new_name, cts, abbrev, octet in AR_CLONES:
            source = device(src, source_name)
            if source is None:
                die('%s has no router named %r to clone' % (SOURCE_SC, source_name))
            if source.get('type') != 'juniper-router':
                die('%s/%s is %r, not a juniper-router; the announcement templates are Junos'
                    % (SOURCE_SC, source_name, source.get('type')))
            r = copy.deepcopy(source)
            r['unique_id'] = ar_uid[new_name]
            r['name'] = new_name
            r['abbreviation'] = abbrev
            r['community_tag_sequence'] = cts
            r['interfaces'] = [{
                'name': 'ae10.%d' % vlan,
                'ip': '172.18.%d.%d' % (vlan, octet),
                'capacity': '10',
                'type': '10G',
                'ingress': str(dp_uid[dp_new]),
                'VLAN': vlan,
            } for _s, dp_new, vlan in DP_CLONES]
            new_devices.append(r)
            print('   CHANGE AR  %-10s ip=%-15s feeds %s  (same box as %s/%s)'
                  % (new_name, r.get('ip'),
                     ', '.join('%s@VLAN%d' % (n, v) for _s, n, v in DP_CLONES),
                     SOURCE_SC, source_name))
        changes += len(new_devices)

        if new_status:
            print('   CHANGE %d device-status row(s), so the clones report a version'
                  % len(new_status))
            changes += len(new_status)

        if args.apply:
            res = db.ScrubbingCenters.update_one(
                {'_id': sc3['_id']}, {'$push': {'management_devices': {'$each': new_devices}}})
            print('          -> devices matched=%d modified=%d' % (res.matched_count, res.modified_count))
            for row in new_status:
                db.ScrubbingCenterDeviceStatuses.replace_one({'_id': row['_id']}, row, upsert=True)
            print('          -> %d status row(s) upserted' % len(new_status))

    print('\n%d change(s), %d already correct.' % (changes, noops))
    if changes and not args.apply:
        print('Nothing was written. Re-run with --apply, then tools/lab_validate.py.')


if __name__ == '__main__':
    main()
