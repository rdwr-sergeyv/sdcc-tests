#!/usr/bin/env python3
"""lab_repair_gre.py -- finish the E-24/E-27 GRE repair, ledger included.

DRY-RUN BY DEFAULT. Pass --apply to write. Precedent: ensure_sc_plan.py, e24_migrate_lab_roles.py.

WHY A SCRIPT AND NOT A MONGOSH SESSION
    The 2026-08-22 repoint was done by hand and fixed the site documents only. It left the allocator's
    ledger untouched, so `allocate_tunnel_id` would have re-issued numbers already on the wire, and it
    created a third `Tunnel1` on LAB-AR-4 -- against the product's own per-router-out uniqueness rule.
    That is exactly the failure mode design decision D5 exists to prevent, demonstrated by hand before
    the tool existed to prevent it. A reference and its bookkeeping are ONE write, or they drift.

WHAT IS DELIBERATELY NOT REPAIRED
    `meir_polisy_site` is renamed to `meir_polisy_site_broken` and left pointing at **NEW-LAB's**
    LAB-AR-3 while sitting on NEW-LAB-2. It is the surviving reproducer for suspect S14 -- a diversion
    that activates with no router-out and reports success. Repairing every site would have destroyed the
    only way to reproduce it. Its network booking and NEW-LAB's tunnel_ids entry for that AR are left
    alone too, so the fixture stays ONE decision rather than a half-repaired mixture. All of it is
    declared in lab/expected-violations.yaml, so it shows as EXPECTED and drifts loudly if it is ever
    quietly fixed.

IDEMPOTENT: every step checks its own precondition, so a second run reports "already done" and writes
nothing. It exits rather than guess whenever the state is neither the before nor the after it expects.

    docker cp tools/lab_repair_gre.py legacy-portal-portal-1:/tmp/lab_repair_gre.py
    docker exec legacy-portal-portal-1 python /tmp/lab_repair_gre.py            # dry run
    docker exec legacy-portal-portal-1 python /tmp/lab_repair_gre.py --apply

Verify with tools/lab_validate.py before and after -- that is the acceptance test.
"""
import argparse
import os
import sys

from pymongo import MongoClient

BROKEN_SITE = 'meir_polisy_site'
BROKEN_SITE_NEW = 'meir_polisy_site_broken'

# The duplicate: three sites claim Tunnel1 on NEW-LAB-2/LAB-AR-4. site_new_lab2 is the incumbent -- it is
# the one the ledger actually books -- so the two that the 2026-08-22 repoint moved take free numbers.
# Measured free on LAB-AR-4 before this runs: 2, 3, 4, 5 (taken: 1, 70).
RENUMBER = [
    ('site_ipv6',    '10.15.2.12/30', 'Tunnel1', 'Tunnel2'),
    ('site_new_lab', '10.15.2.20/30', 'Tunnel1', 'Tunnel3'),
]

# Devices E-24 deleted. Their bookings can never correspond to anything again.
GONE_DEVICES = ['5e08d6bc2cbdfd701f0c2937', '5e08d6bc2cbdfd701f0c2943']

# Networks used by sites that now live on NEW-LAB-2, still booked under NEW-LAB.
# 10.15.2.16/30 is deliberately absent: it belongs to the broken fixture.
MOVE_NETWORKS = ['10.15.2.0/30', '10.15.2.4/30', '10.15.2.8/30', '10.15.2.12/30',
                 '10.15.2.20/30', '10.15.2.24/30', '10.15.2.40/30']


class Repair(object):
    def __init__(self, db, apply_):
        self.db, self.apply = db, apply_
        self.changes = self.noops = 0

    def do(self, what, coll, query, update):
        self.changes += 1
        print('  CHANGE %s' % what)
        if self.apply:
            res = self.db[coll].update_one(query, update)
            print('         -> matched=%d modified=%d' % (res.matched_count, res.modified_count))

    def skip(self, what):
        self.noops += 1
        print('  ok     %s' % what)


def sc_id_by_name(db, name):
    sc = db.ScrubbingCenters.find_one({'name': name}, {'_id': 1})
    if sc is None:
        sys.exit('no scrubbing center named %r' % name)
    return sc['_id']


def device_uid(db, sc_name, dev_name):
    """Resolve a device by (SC, name) -- never by name alone.

    NEW-LAB and NEW-LAB-2 both own a LAB-AR-3. Resolving one by name is the exact mistake that made
    site_new_lab read as 4-of-5 tunnels healthy when all five were unusable.
    """
    sc = db.ScrubbingCenters.find_one({'name': sc_name})
    if sc is None:
        sys.exit('no scrubbing center named %r' % sc_name)
    for d in sc.get('management_devices') or []:
        if d.get('name') == dev_name:
            return str(d.get('unique_id'))
    sys.exit('no device %s in %s' % (dev_name, sc_name))


def tunnel_entries(db, sc_id, uid):
    """(site, network, number) for every tunnel on (site's SC, router-out) -- the allocator's own key.

    allocate_tunnel_id(db, acc_site['sc_id'], router_out_id, n) books under the SITE's SC
    (sdcc-portal/portal/api/site.py:1001), so the ledger is keyed that way and this must match it.
    """
    out = []
    for site in db.AccountSites.find({'sc_id': sc_id}):
        for t in site.get('gre_info') or []:
            if str(t.get('gre_device_uid')) == uid:
                name = t.get('tunnel_name') or ''
                if name.startswith('Tunnel'):
                    out.append((site.get('name'), t.get('tunnel_network'), name[len('Tunnel'):]))
    return out


def planned_numbers(db, sc_id, uid):
    """The numbers in use AFTER step 2, whether or not step 2 has already been written.

    Per ENTRY, not by set arithmetic. A first version discarded the old number from a set, which quietly
    deleted site_new_lab2's legitimate Tunnel1 from the preview because two OTHER sites were being
    renumbered off the same value on the same AR. The dry run then proposed a booking that would have
    left a live tunnel unbooked -- the very drift this script exists to end.
    """
    rename = dict(((site, net), new[len('Tunnel'):]) for site, net, _old, new in RENUMBER)
    return set(rename.get((site, net), number) for site, net, number in tunnel_entries(db, sc_id, uid))


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('--apply', action='store_true', help='write; without it nothing is changed')
    args = p.parse_args()

    db = MongoClient(os.environ.get('SDCC_MONGO_HOST', 'localhost'),
                     int(os.environ.get('SDCC_MONGO_PORT', 27017)),
                     directConnection=True)[os.environ.get('SDCC_MONGO_DB', 'sdcc')]
    r = Repair(db, args.apply)
    print('lab_repair_gre -- %s\n' % ('APPLYING' if args.apply else 'DRY RUN (pass --apply to write)'))

    nl2 = sc_id_by_name(db, 'NEW-LAB-2')
    nl = sc_id_by_name(db, 'NEW-LAB')
    ar3 = device_uid(db, 'NEW-LAB-2', 'LAB-AR-3')
    ar4 = device_uid(db, 'NEW-LAB-2', 'LAB-AR-4')

    print('1. rename the deliberate S14 reproducer so it is obvious in every list')
    if db.AccountSites.find_one({'name': BROKEN_SITE_NEW}):
        r.skip('%s already renamed' % BROKEN_SITE_NEW)
    elif db.AccountSites.find_one({'name': BROKEN_SITE}):
        r.do('%s -> %s' % (BROKEN_SITE, BROKEN_SITE_NEW), 'AccountSites',
             {'name': BROKEN_SITE}, {'$set': {'name': BROKEN_SITE_NEW}})
    else:
        sys.exit('neither %r nor %r exists -- refusing to guess' % (BROKEN_SITE, BROKEN_SITE_NEW))

    print('\n2. renumber the duplicate Tunnel1 on NEW-LAB-2/LAB-AR-4')
    for site_name, network, old, new in RENUMBER:
        site = db.AccountSites.find_one({'name': site_name})
        if site is None:
            sys.exit('no site %r' % site_name)
        idx = next((i for i, t in enumerate(site.get('gre_info') or [])
                    if t.get('tunnel_network') == network), None)
        if idx is None:
            sys.exit('%s has no tunnel on %s -- refusing to guess' % (site_name, network))
        current = site['gre_info'][idx].get('tunnel_name')
        if current == new:
            r.skip('%s %s already %s' % (site_name, network, new))
        elif current != old:
            sys.exit('%s %s is %r, expected %r or %r' % (site_name, network, current, old, new))
        else:
            r.do('%s %s: %s -> %s' % (site_name, network, old, new), 'AccountSites',
                 {'_id': site['_id']}, {'$set': {'gre_info.%d.tunnel_name' % idx: new}})

    print('\n3. book what is actually in use, in the NEW-LAB-2 ledger')
    for uid, label in ((ar3, 'LAB-AR-3'), (ar4, 'LAB-AR-4')):
        # Read the truth off the sites rather than restate it as a literal, and read it as it will be
        # once step 2 has run -- so the dry run previews the same booking the apply will write.
        want = sorted(planned_numbers(db, nl2, uid), key=int)
        doc = db.ScGREResourceIds.find_one({'_id': {'sc_id': nl2}}) or {}
        have = sorted((doc.get('tunnel_ids') or {}).get(uid, []), key=int)
        if have == want:
            r.skip('NEW-LAB-2/%s already books %s' % (label, want))
        else:
            r.do('NEW-LAB-2/%s booked %s -> %s' % (label, have, want), 'ScGREResourceIds',
                 {'_id': {'sc_id': nl2}}, {'$set': {'tunnel_ids.%s' % uid: want}})

    print('\n4. unbook the tunnel numbers of devices E-24 deleted')
    doc = db.ScGREResourceIds.find_one({'_id': {'sc_id': nl}}) or {}
    for uid in GONE_DEVICES:
        booked = (doc.get('tunnel_ids') or {}).get(uid)
        if booked is None:
            r.skip('NEW-LAB no longer books %s' % uid)
        else:
            r.do('NEW-LAB drop tunnel_ids.%s (was %s)' % (uid, sorted(booked, key=int)),
                 'ScGREResourceIds', {'_id': {'sc_id': nl}}, {'$unset': {'tunnel_ids.%s' % uid: ''}})

    print('\n5. move the tunnel networks to the SC that owns the sites')
    nl_v4 = list((db.ScGREResourceIds.find_one({'_id': {'sc_id': nl}}) or {}).get('gre_networks_v4') or [])
    nl2_v4 = list((db.ScGREResourceIds.find_one({'_id': {'sc_id': nl2}}) or {}).get('gre_networks_v4') or [])
    to_move = [n for n in MOVE_NETWORKS if n in nl_v4]
    if not to_move:
        r.skip('all %d networks already off NEW-LAB' % len(MOVE_NETWORKS))
    else:
        r.do('NEW-LAB gre_networks_v4 -= %s' % to_move, 'ScGREResourceIds',
             {'_id': {'sc_id': nl}},
             {'$set': {'gre_networks_v4': sorted(n for n in nl_v4 if n not in MOVE_NETWORKS)}})
    missing = [n for n in MOVE_NETWORKS if n not in nl2_v4]
    if not missing:
        r.skip('NEW-LAB-2 already books all %d networks' % len(MOVE_NETWORKS))
    else:
        r.do('NEW-LAB-2 gre_networks_v4 += %s' % missing, 'ScGREResourceIds',
             {'_id': {'sc_id': nl2}},
             {'$set': {'gre_networks_v4': sorted(set(nl2_v4) | set(MOVE_NETWORKS))}})

    print('\n%d change(s), %d already correct.' % (r.changes, r.noops))
    if r.changes and not args.apply:
        print('Nothing was written. Re-run with --apply, then tools/lab_validate.py.')


if __name__ == '__main__':
    main()
