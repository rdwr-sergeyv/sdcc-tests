#!/usr/bin/env python3
"""lab_validate.py -- check the lab against the domain constraints, including the ones nothing enforces.

READ-ONLY. It opens no write, so it is safe with tasks in flight -- though it reports them, because nothing
may be MUTATED while any is unfinished.

WHY THIS EXISTS
    Design decision D5 (docs/tasks/lab-profiles/Design.md): a tool that writes straight to Mongo must obey
    every domain constraint, including the many the product does not enforce. This is that catalogue, made
    executable. It is the first thing built because it is useful alone: run against the lab on 2026-08-13 it
    would have caught the dangling GRE tunnels the day the E-24 migration created them, instead of nine days
    later when a diversion silently activated with no access router.

THE RULE THAT SHAPES EVERY CHECK
    Ask "is the target in the SC it must be in", never "does the target exist". Device NAMES repeat across
    SCs -- NEW-LAB and NEW-LAB-2 both own a LAB-AR-3 -- so an existence check reported site_new_lab as
    4-of-5 tunnels healthy when all five were unusable. Ids do not repeat, but their owner still has to be
    checked.

USAGE -- from any container that has pymongo and the lab's SDCC_MONGO_* environment. The portal container
is the reliable one, because it is the one that stays up:

    docker cp tools/lab_validate.py           legacy-portal-portal-1:/tmp/lab_validate.py
    docker cp lab/expected-violations.yaml    legacy-portal-portal-1:/tmp/expected.yaml
    docker exec legacy-portal-portal-1 python /tmp/lab_validate.py --expect /tmp/expected.yaml
    docker exec legacy-portal-portal-1 python /tmp/lab_validate.py --json

From Git Bash, prefix `docker exec` with MSYS_NO_PATHCONV=1 or /tmp/... is rewritten to a Windows path.
Without --mongo-host it reads SDCC_MONGO_HOST / _PORT / _DB, which the container already sets.

DECLARED EXCEPTIONS (design decision D6)
    Some violations are deliberate: LAB4-DP-3 sits in the Escalation SC on purpose, as a broken environment
    proving escalation's DP filtering really filters. Declare those, with a reason:

        expected_violations:
          - id: ESC-SC-DP-ZONE
            target: "NEW-LAB/LAB4-DP-3"
            reason: "deliberate: a default-zone DP in the Escalation SC proves the filter filters"

    A declared violation that NO LONGER OCCURS is reported as drift -- that is the point of declaring it
    rather than lowering its severity, so a fixture which stops being deliberate cannot hide.

EXIT CODE
    1 if any unexpected ERROR finding, else 0.
"""
import argparse
import collections
import json
import os
import sys

from pymongo import MongoClient

# Mirrored from the product rather than guessed; overridden by a real import when sdcc is available.
MAX_SC_NUM = 99                     # documents.py:4506, and the test is `seq >= MAX_SC_NUM`
MINIMUM_DPS_FOR_ESCALATION = 2      # constants.py, alongside MINIMUM_DPS_FOR_ISOLATION
ATTACK_ZONE_NAME = 'attack_zone'
DP_ROLE = 'radware-defensepro'
ROUTER_OUT = 'router-out'
ESCALATION = 'escalation'
BUSY_TASK_STATUSES = ('in_queue', 'pending', 'in_progress')
TRANSITIONAL_STATUSES = ('activating', 'deactivating', 'pending', 'on-cloud-bGP-pending')

ERROR, WARN, INFO = 'ERROR', 'WARN', 'INFO'

# Enforcement is not a boolean. A rule the product checks when it CREATES something, but never re-checks
# against stored state, is the most dangerous kind for a tool that writes straight to Mongo (design D5):
# it looks enforced when you read the code, and is absent when you write the document yourself.
WRITE_PATH = 'write-path'

def _adopt(name, fallback):
    """Take the product's value when the running code has it, else the literal above.

    One name at a time, deliberately: MINIMUM_DPS_FOR_ESCALATION exists only on the escalation feature
    branch, so a single combined import would silently drop ATTACK_ZONE_NAME too whenever the tool runs
    against a container built from `dev`. The report prints which names were adopted, so a run never has
    to be trusted blind.
    """
    try:
        import sdcc.common.constants as _c
        return getattr(_c, name), True
    except Exception:
        return fallback, False


ATTACK_ZONE_NAME, _az_ok = _adopt('ATTACK_ZONE_NAME', ATTACK_ZONE_NAME)
try:  # role names and the INBOUND group, from the product's own enum
    from sdcc.common.constants import DEVICE_ROLE as _DR
    DP_ROLE, ROUTER_OUT, INBOUND_ROLES = _DR.DEFENSE_PRO, _DR.ROUTER_OUT, tuple(_DR.INBOUND)
except Exception:
    INBOUND_ROLES = ('switch-in', 'router-in')   # DEVICE_ROLE.INBOUND, constants.py:365
MINIMUM_DPS_FOR_ESCALATION, _min_ok = _adopt('MINIMUM_DPS_FOR_ESCALATION', MINIMUM_DPS_FOR_ESCALATION)
MAX_SC_NUM, _max_ok = _adopt('MAX_SC_NUM', MAX_SC_NUM)
_adopted = [n for n, ok in (('ATTACK_ZONE_NAME', _az_ok), ('MINIMUM_DPS_FOR_ESCALATION', _min_ok),
                            ('MAX_SC_NUM', _max_ok)) if ok]
CONSTANTS_SOURCE = ('imported from sdcc.common.constants: %s' % ', '.join(_adopted)) if _adopted else None
if len(_adopted) < 3:
    _fell_back = [n for n in ('ATTACK_ZONE_NAME', 'MINIMUM_DPS_FOR_ESCALATION', 'MAX_SC_NUM')
                  if n not in _adopted]
    CONSTANTS_SOURCE = ((CONSTANTS_SOURCE + '; ') if CONSTANTS_SOURCE else '') +         'literals in this file: %s' % ', '.join(_fell_back)

Finding = collections.namedtuple('Finding', 'id severity target message')
CHECKS = []


def check(constraint_id, severity, enforced_by_product, why):
    """Register a constraint. `enforced_by_product` matters: the unenforced ones are where a tool that
    writes directly can do real damage, so the report says which is which."""
    def wrap(fn):
        fn.constraint_id = constraint_id
        fn.severity = severity
        fn.enforced = enforced_by_product
        fn.why = why
        CHECKS.append(fn)
        return fn
    return wrap


# --------------------------------------------------------------------------------------------- fabric model

class Fabric(object):
    """Everything the checks need, read once."""

    def __init__(self, db):
        self.db = db
        self.scs = list(db.ScrubbingCenters.find({}))
        self.by_sc = {sc['_id']: sc for sc in self.scs}
        self.zone_name = {z['_id']: z.get('name') for z in db.DPZones.find({}, {'name': 1})}
        self.sites = list(db.AccountSites.find({}))
        self.assets = list(db.Assets.find({}))
        self.gre_res = list(db.ScGREResourceIds.find({}))
        self.providers = {str(pr['_id']): pr.get('name') for pr in db.Providers.find({}, {'name': 1})}
        self.versions = {}
        for st in db.ScrubbingCenterDeviceStatuses.find({}, {'dp_version': 1}):
            self.versions[st.get('_id', {}).get('device_uid')] = st.get('dp_version')

    def sc_name(self, sc_id):
        sc = self.by_sc.get(sc_id)
        return sc.get('name') if sc else '<unknown SC %s>' % sc_id

    def devices(self, sc, roles=None):
        for d in sc.get('management_devices') or []:
            if roles is None or d.get('role') in roles:
                yield d

    def device_owner(self, uid):
        """Which SC holds this device id -- the membership question, asked once."""
        for sc in self.scs:
            for d in self.devices(sc):
                if str(d.get('unique_id')) == str(uid):
                    return sc, d
        return None, None

    def device_label(self, uid):
        """'OWNING-SC/name [uid-tail]', never just the name.

        Names repeat across SCs -- NEW-LAB and NEW-LAB-2 both own a LAB-AR-3 -- so a bare name in a report
        is the same trap the checks exist to catch. An earlier draft of this file printed the SITE's SC
        next to the device name and produced 'NEW-LAB-2/LAB-AR-3' for a device that lives in NEW-LAB.
        """
        owner, dev = self.device_owner(uid)
        if dev is None:
            return '<device %s, present in no SC>' % uid
        return '%s/%s [%s]' % (owner.get('name'), dev.get('name'), str(uid)[-6:])

    def is_escalation(self, sc):
        return sc.get('sc_type') == ESCALATION

    def ingress_map(self, sc):
        """router-out interfaces of this SC, keyed by the DP uid they feed.

        ROUTER-OUT ONLY, and that is measured rather than assumed: in NEW-LAB-2 every one of the 18
        router-out interfaces points at a DP of that SC, while the router-in devices have no interfaces at
        all. `_args_add_metrics` reads the router-out side, which is the one that decides whether a DP is
        reachable. Router-in interfaces elsewhere carry ids that are not devices (see IFACE-INGRESS-UNKNOWN).
        """
        out = collections.defaultdict(list)
        for r in self.devices(sc, (ROUTER_OUT,)):
            for i in r.get('interfaces') or []:
                out[str(i.get('ingress'))].append((r, i))
        return out


# --------------------------------------------------------------------------------------------- SC / mapping

@check('SC-TYPE-VALID', ERROR, True,
       'sc_type is a closed set; anything else makes every later decision undefined')
def sc_type_valid(f):
    for sc in f.scs:
        t = sc.get('sc_type')
        if t is not None and t not in ('standard', ESCALATION):
            yield Finding('SC-TYPE-VALID', ERROR, sc.get('name'), 'sc_type=%r' % t)


@check('SC-MAPPING-TARGET', ERROR, True,
       'escalates_to must name an Escalation SC, or traffic escalates to somewhere with no capacity')
def sc_mapping_target(f):
    for sc in f.scs:
        target_id = sc.get('escalates_to')
        if not target_id:
            continue
        target = f.by_sc.get(target_id)
        if target is None:
            yield Finding('SC-MAPPING-TARGET', ERROR, sc.get('name'),
                          'escalates_to points at %s, which does not exist' % target_id)
        elif not f.is_escalation(target):
            yield Finding('SC-MAPPING-TARGET', ERROR, sc.get('name'),
                          'escalates_to names %s, which is %s' % (target.get('name'),
                                                                  target.get('sc_type') or 'standard'))


@check('SC-MAPPING-CHAIN', ERROR, True,
       'an Escalation SC must not escalate onwards; a chain has no defined end')
def sc_mapping_chain(f):
    for sc in f.scs:
        if f.is_escalation(sc) and sc.get('escalates_to'):
            yield Finding('SC-MAPPING-CHAIN', ERROR, sc.get('name'),
                          'escalates_to is set on an Escalation SC')


@check('ESC-SC-NO-SITES', ERROR, True,
       'an Escalation SC has no account sites; traffic reaches it by escalation')
def esc_sc_no_sites(f):
    esc_ids = {sc['_id'] for sc in f.scs if f.is_escalation(sc)}
    for site in f.sites:
        if site.get('sc_id') in esc_ids:
            yield Finding('ESC-SC-NO-SITES', ERROR, site.get('name'),
                          'account site sits on Escalation SC %s' % f.sc_name(site.get('sc_id')))


@check('ESC-SC-DP-ZONE', ERROR, False,
       'CDDOS-3009 selects ALL DPs at the Escalation SC, so a DP outside the attack zone makes that '
       'rule ambiguous. Nothing in the product refuses it')
def esc_sc_dp_zone(f):
    for sc in f.scs:
        if not f.is_escalation(sc):
            continue
        for d in f.devices(sc, (DP_ROLE,)):
            zone = f.zone_name.get(d.get('zone'))
            if zone != ATTACK_ZONE_NAME:
                yield Finding('ESC-SC-DP-ZONE', ERROR, '%s/%s' % (sc.get('name'), d.get('name')),
                              'DP in an Escalation SC is in zone %r, not %s' % (zone, ATTACK_ZONE_NAME))


@check('ESC-SC-QUORUM', ERROR, True,
       'below the quorum an escalate is refused at request time, which is a lab that cannot test the feature')
def esc_sc_quorum(f):
    for sc in f.scs:
        if not f.is_escalation(sc):
            continue
        wired = f.ingress_map(sc)
        usable = []
        for d in f.devices(sc, (DP_ROLE,)):
            uid = str(d.get('unique_id'))
            version = f.versions.get(d.get('unique_id'))
            try:
                is_dpx = int(str(version).split('.')[0]) >= 10
            except (TypeError, ValueError):
                is_dpx = False          # no status record means no known version: refuse for want of evidence
            if is_dpx and f.zone_name.get(d.get('zone')) == ATTACK_ZONE_NAME and wired.get(uid):
                usable.append(d.get('name'))
        if len(usable) < MINIMUM_DPS_FOR_ESCALATION:
            yield Finding('ESC-SC-QUORUM', ERROR, sc.get('name'),
                          '%d usable DPx (need %d); usable: %s'
                          % (len(usable), MINIMUM_DPS_FOR_ESCALATION, ', '.join(usable) or 'none'))
        # policy capacity is NOT evaluated here -- it needs is_dp_status_blocked's product logic. Stated
        # rather than silently skipped: this count is an upper bound.


@check('ASSET-ADD-SC-NOT-ESC', ERROR, True,
       'an additional SC announces alongside the main one, permanently; an Escalation SC is reached by '
       'escalation. A leg created that way is indistinguishable from an escalated one')
def asset_additional_sc(f):
    esc_ids = {sc['_id'] for sc in f.scs if f.is_escalation(sc)}
    for a in f.assets:
        for sd in a.get('asset_site_data') or []:
            for add in sd.get('asset_additional_site') or []:
                if add.get('sc_id') in esc_ids:
                    yield Finding('ASSET-ADD-SC-NOT-ESC', ERROR, a.get('name'),
                                  'additional SC is the Escalation SC %s' % f.sc_name(add.get('sc_id')))


# --------------------------------------------------------------------------------------------- wiring

@check('DP-WIRED', ERROR, False,
       'a DP with no router-out interface in its own SC is dropped silently from metrics at render time '
       '-- CSP-969 exactly. Nothing in the product refuses it')
def dp_wired(f):
    for sc in f.scs:
        wired = f.ingress_map(sc)
        for d in f.devices(sc, (DP_ROLE,)):
            if not wired.get(str(d.get('unique_id'))):
                yield Finding('DP-WIRED', ERROR, '%s/%s' % (sc.get('name'), d.get('name')),
                              'DP has no router-out interface whose ingress is its uid, in this SC')


@check('IFACE-ORPHAN', WARN, False,
       'an interface feeding a DP that is not in this SC is left over from a move; harmless to renders '
       'today, and the fingerprint of a half-finished migration')
def iface_orphan(f):
    for sc in f.scs:
        own = {str(d.get('unique_id')) for d in f.devices(sc, (DP_ROLE,))}
        for uid, entries in f.ingress_map(sc).items():
            if uid in own or uid in ('None', ''):
                continue
            for router, iface in entries:
                yield Finding('IFACE-ORPHAN', WARN, '%s/%s' % (sc.get('name'), router.get('name')),
                              'interface VLAN=%s ip=%s feeds %s, not a DP of this SC'
                              % (iface.get('VLAN'), iface.get('ip'), uid))


@check('IFACE-INGRESS-PROVIDER', WARN, False,
       'on an INBOUND device (router-in / switch-in) `interfaces[].ingress` names a PROVIDER, not a DP -- '
       '`get_connected_ingress_providers_map` (documents.py:4645) looks it up in Providers and silently '
       'drops anything it cannot resolve, so the SC then reads as connected to no provider')
def iface_ingress_provider(f):
    """The role decides what `ingress` means, and this took a measurement to learn rather than a guess.

    Measured on the lab: router-out interfaces point at a DP 28/28 times, DP interfaces carry None 66/66,
    and all 4 INBOUND interfaces carry one id that is a **Providers** document. The product agrees --
    documents.py:4645 resolves it against Providers for `DEVICE_ROLE.INBOUND` exactly, while
    documents.py:3945 and execution_tree_builder.py:962 are the router-out/DP side. An earlier version of
    this check called all four a dangling device reference; they were correct all along.
    """
    for sc in f.scs:
        for r in f.devices(sc, INBOUND_ROLES):
            for i in r.get('interfaces') or []:
                uid = str(i.get('ingress'))
                if uid in ('None', ''):
                    yield Finding('IFACE-INGRESS-PROVIDER', WARN, '%s/%s' % (sc.get('name'), r.get('name')),
                                  'interface VLAN=%s ip=%s names no provider' % (i.get('VLAN'), i.get('ip')))
                elif uid not in f.providers:
                    yield Finding('IFACE-INGRESS-PROVIDER', WARN, '%s/%s' % (sc.get('name'), r.get('name')),
                                  'interface VLAN=%s ip=%s has ingress=%s, which is no Provider'
                                  % (i.get('VLAN'), i.get('ip'), uid))


# --------------------------------------------------------------------------------------------- GRE / tunnels

@check('GRE-TUNNEL-SC', ERROR, False,
       "the automatic AR selection reads these ids; one pointing outside the site's own SC yields a "
       'diversion with NO router-out that activates and reports success (E-27, suspect S14)')
def gre_tunnel_sc(f):
    for site in f.sites:
        site_sc = site.get('sc_id')
        for t in site.get('gre_info') or []:
            uid = t.get('gre_device_uid')
            owner, dev = f.device_owner(uid)
            if owner is None:
                yield Finding('GRE-TUNNEL-SC', ERROR, site.get('name'),
                              'tunnel %s -> device %s exists in NO SC' % (t.get('tunnel_name'), uid))
            elif owner['_id'] != site_sc:
                yield Finding('GRE-TUNNEL-SC', ERROR, site.get('name'),
                              'tunnel %s -> %s, which belongs to %s, but the site is on %s'
                              % (t.get('tunnel_name'), dev.get('name'), owner.get('name'),
                                 f.sc_name(site_sc)))
            elif dev.get('role') != ROUTER_OUT:
                yield Finding('GRE-TUNNEL-SC', ERROR, site.get('name'),
                              'tunnel %s -> %s, which is a %s, not a %s'
                              % (t.get('tunnel_name'), dev.get('name'), dev.get('role'), ROUTER_OUT))


@check('GRE-TUNNEL-ID-UNIQUE', ERROR, WRITE_PATH,
       "per-router-out uniqueness is the product's own model: allocate_tunnel_id() books ids under "
       '`tunnel_ids.<router_out_id>` and raises "Tunnel{n} is already used on AR router" '
       '(util/scrubbing_center.py:617-633). It is checked when a tunnel is ALLOCATED and never again, so '
       'state that arrives another way -- a migration, a repoint, this tool -- is unchecked')
def gre_tunnel_unique(f):
    seen = collections.defaultdict(list)
    for site in f.sites:
        for t in site.get('gre_info') or []:
            seen[(str(t.get('gre_device_uid')), t.get('tunnel_name'))].append(
                '%s(%s)' % (site.get('name'), t.get('tunnel_network')))
    for (uid, name), users in sorted(seen.items()):
        if len(users) > 1:
            yield Finding('GRE-TUNNEL-ID-UNIQUE', ERROR, f.device_label(uid),
                          '%s claimed by %d tunnels: %s' % (name, len(users), ', '.join(users)))


@check('GRE-BOOKING', WARN, WRITE_PATH,
       "ScGREResourceIds.tunnel_ids is the allocator's ledger of which tunnel numbers are taken on which "
       'router-out. A tunnel in use but unbooked means the next allocate_tunnel_id() will hand the same '
       'number out again -- the ledger, not the reality, is what it consults')
def gre_booking(f):
    """Both directions, because they fail differently.

    Unbooked-but-in-use is the one that bites: the allocator consults the ledger, so it will cheerfully
    issue a number that is already on the wire. Booked-but-unused only leaks numbers. Neither is visible
    to the product, which re-reads the ledger and never the sites.
    """
    booked = {}
    for doc in f.gre_res:
        sc_id = doc.get('_id', {}).get('sc_id')
        for dev_uid, ids in (doc.get('tunnel_ids') or {}).items():
            booked[(sc_id, str(dev_uid))] = set(str(i) for i in ids)
    in_use = collections.defaultdict(set)
    for site in f.sites:
        for t in site.get('gre_info') or []:
            name = t.get('tunnel_name') or ''
            number = name[len('Tunnel'):] if name.startswith('Tunnel') else name
            in_use[(site.get('sc_id'), str(t.get('gre_device_uid')))].add(str(number))
    for key, numbers in sorted(in_use.items(), key=lambda kv: str(kv[0])):
        sc_id, uid = key
        missing = numbers - booked.get(key, set())
        if missing:
            yield Finding('GRE-BOOKING', WARN, f.device_label(uid),
                          'tunnel number(s) %s in use but NOT booked in the %s ledger'
                          % (', '.join(sorted(missing)), f.sc_name(sc_id)))
    for key, numbers in sorted(booked.items(), key=lambda kv: str(kv[0])):
        sc_id, uid = key
        stale = numbers - in_use.get(key, set())
        if stale:
            yield Finding('GRE-BOOKING', WARN, f.device_label(uid),
                          'tunnel number(s) %s booked in the %s ledger but used by no site'
                          % (', '.join(sorted(stale)), f.sc_name(sc_id)))


@check('GRE-NET-OWNER', WARN, False,
       "a tunnel network booked to an SC that no longer owns the site leaves allocation lying about who "
       'holds what; it bites when the range is handed out again')
def gre_net_owner(f):
    booked = {}
    for doc in f.gre_res:
        sc_id = doc.get('_id', {}).get('sc_id')
        for net in (doc.get('gre_networks_v4') or []) + (doc.get('gre_networks_v6') or []):
            booked.setdefault(net, []).append(sc_id)
    for site in f.sites:
        for t in site.get('gre_info') or []:
            net = t.get('tunnel_network') or t.get('tunnel_network_v6')
            if not net:
                continue
            owners = booked.get(net)
            if not owners:
                yield Finding('GRE-NET-OWNER', WARN, site.get('name'),
                              'tunnel network %s is booked to no SC' % net)
            elif site.get('sc_id') not in owners:
                yield Finding('GRE-NET-OWNER', WARN, site.get('name'),
                              'tunnel network %s is booked to %s, but the site is on %s'
                              % (net, ', '.join(f.sc_name(o) for o in owners), f.sc_name(site.get('sc_id'))))


# --------------------------------------------------------------------------------------------- tenant data

@check('INCIDENT-DEV-MEMBERSHIP', ERROR, False,
       'a leg referencing a device absent from its SC cannot be rendered or torn down correctly. ERROR '
       'while the incident is open; closed incidents are history and reported as INFO')
def incident_dev_membership(f):
    for inc in f.db.Incidents.find({}, {'asset': 1, 'status': 1, 'endedAt': 1, 'diversion': 1}):
        is_open = inc.get('endedAt') is None
        severity = ERROR if is_open else INFO
        for d in inc.get('diversion') or []:
            sc = f.by_sc.get(d.get('sc_id'))
            if sc is None:
                yield Finding('INCIDENT-DEV-MEMBERSHIP', severity, str(inc['_id']),
                              'leg on SC %s, which does not exist' % d.get('sc_id'))
                continue
            own = {str(x.get('unique_id')) for x in f.devices(sc)}
            for uid, entry in ((d.get('state') or {}).get('topology') or {}).items():
                if entry.get('selected') and str(uid) not in own:
                    yield Finding('INCIDENT-DEV-MEMBERSHIP', severity, str(inc['_id']),
                                  '%s leg selects %s, absent from that SC'
                                  % (sc.get('name'), uid))
            # original_selected_dp_ids is the other place a device id lingers, and the one the E-24
            # migration plan flagged as its main risk (C1, "dangling ObjectIds in those incidents").
            for uid in d.get('original_selected_dp_ids') or []:
                if str(uid) not in own:
                    yield Finding('INCIDENT-DEV-MEMBERSHIP', severity, str(inc['_id']),
                                  '%s leg original_selected_dp_ids holds %s, absent from that SC'
                                  % (sc.get('name'), uid))


@check('ASSET-SITE-SC-MATCH', WARN, False,
       "the asset's own copy of sc_id should agree with its account site; the read path overwrites it, so "
       'a mismatch is invisible in the UI and confusing in the database')
def asset_site_sc_match(f):
    by_site = {s['_id']: s for s in f.sites}
    for a in f.assets:
        for sd in a.get('asset_site_data') or []:
            site = by_site.get(sd.get('account_site'))
            if site is None:
                yield Finding('ASSET-SITE-SC-MATCH', WARN, a.get('name'),
                              'site %s does not exist' % sd.get('account_site'))
            elif sd.get('sc_id') and sd.get('sc_id') != site.get('sc_id'):
                yield Finding('ASSET-SITE-SC-MATCH', WARN, a.get('name'),
                              'asset_site_data.sc_id=%s but site %s is on %s'
                              % (f.sc_name(sd.get('sc_id')), site.get('name'),
                                 f.sc_name(site.get('sc_id'))))


@check('ENUM-CEILING', ERROR, False,
       'at the ceiling no SC can be created at all, and a refused create still consumes a number '
       '(suspect S10). Below the highest value in use, the next create collides')
def enum_ceiling(f):
    seq_doc = f.db.Enumerators.find_one({'_id': 'ScrubbingCenter'})
    if not seq_doc:
        return
    seq = seq_doc.get('seq')
    in_use = [sc.get('community_tag_sequence') for sc in f.scs if sc.get('community_tag_sequence')]
    highest = max(in_use) if in_use else 0
    if seq is not None and seq >= MAX_SC_NUM:
        yield Finding('ENUM-CEILING', ERROR, 'Enumerators/ScrubbingCenter',
                      'seq=%s has reached MAX_SC_NUM=%s; no SC can be created' % (seq, MAX_SC_NUM))
    if seq is not None and seq < highest:
        yield Finding('ENUM-CEILING', ERROR, 'Enumerators/ScrubbingCenter',
                      'seq=%s is below the highest community_tag_sequence in use (%s)' % (seq, highest))


@check('MUTATION-GATE', INFO, False,
       'not a defect -- the state that must be empty before anything writes '
       '(docs/kb/runbooks/lab-stack-reference.md 3a)')
def mutation_gate(f):
    busy = f.db.Tasks.count_documents({'status': {'$in': list(BUSY_TASK_STATUSES)}})
    queued = f.db.Incidents.count_documents({'in_queue': True, 'endedAt': None})
    if busy:
        yield Finding('MUTATION-GATE', INFO, 'Tasks', '%d task(s) in %s' % (busy, '/'.join(BUSY_TASK_STATUSES)))
    if queued:
        yield Finding('MUTATION-GATE', INFO, 'Incidents', '%d incident(s) with in_queue=true' % queued)
    for a in f.db.Assets.find({'status': {'$in': list(TRANSITIONAL_STATUSES)}}, {'name': 1, 'status': 1}):
        yield Finding('MUTATION-GATE', INFO, a.get('name'),
                      'asset is in transitional status %r' % a.get('status'))
    activated = f.db.Incidents.count_documents({'endedAt': None, 'status': 'activated'})
    if activated:
        yield Finding('MUTATION-GATE', INFO, 'Incidents',
                      '%d activated incident(s) -- a profile switch BLOCKS on these (design D2)' % activated)


# --------------------------------------------------------------------------------------------- runner

def load_expected(path):
    if not path:
        return []
    text = open(path).read()
    try:
        import yaml
        doc = yaml.safe_load(text) or {}
    except ImportError:
        doc = json.loads(text)
    return doc.get('expected_violations') or []


def matches(exp, finding):
    if exp.get('id') != finding.id:
        return False
    target = exp.get('target')
    return target in (None, '*', finding.target)


def main():
    p = argparse.ArgumentParser(description='validate the lab against the domain constraint catalogue')
    p.add_argument('--expect', help='YAML/JSON file with expected_violations (a profile fragment)')
    p.add_argument('--json', action='store_true', dest='as_json')
    p.add_argument('--mongo-host')
    p.add_argument('--mongo-port')
    p.add_argument('--db')
    args = p.parse_args()

    host = args.mongo_host or os.environ.get('SDCC_MONGO_HOST', 'localhost')
    port = int(args.mongo_port or os.environ.get('SDCC_MONGO_PORT', 27017))
    dbname = args.db or os.environ.get('SDCC_MONGO_DB', 'sdcc')
    db = MongoClient(host, port, directConnection=True)[dbname]

    fabric = Fabric(db)
    expected = load_expected(args.expect)

    findings, unexpected_errors = [], 0
    matched_expectations = set()
    for fn in CHECKS:
        for finding in fn(fabric) or []:
            exp_index = next((i for i, e in enumerate(expected) if matches(e, finding)), None)
            if exp_index is not None:
                matched_expectations.add(exp_index)
                findings.append((finding, 'EXPECTED', expected[exp_index].get('reason', '')))
            else:
                findings.append((finding, finding.severity, ''))
                if finding.severity == ERROR:
                    unexpected_errors += 1

    drift = [e for i, e in enumerate(expected) if i not in matched_expectations]

    if args.as_json:
        print(json.dumps({
            'constants': CONSTANTS_SOURCE,
            'findings': [{'id': f.id, 'severity': s, 'target': f.target, 'message': f.message,
                          'reason': r} for f, s, r in findings],
            'drift': drift,
            'unexpected_errors': unexpected_errors,
        }, indent=2, default=str))
        return 1 if unexpected_errors else 0

    print('lab_validate -- %d constraints, constants %s' % (len(CHECKS), CONSTANTS_SOURCE))
    print('%d SCs, %d sites, %d assets\n' % (len(fabric.scs), len(fabric.sites), len(fabric.assets)))

    by_id = collections.OrderedDict()
    for finding, shown, reason in findings:
        by_id.setdefault(finding.id, []).append((finding, shown, reason))

    for fn in CHECKS:
        rows = by_id.get(fn.constraint_id)
        enforced = {True: 'product-enforced',
                    False: 'NOT enforced by the product',
                    WRITE_PATH: 'enforced on the WRITE PATH only -- invisible to a direct DB write'}[fn.enforced]
        if not rows:
            print('  ok    %-24s (%s)' % (fn.constraint_id, enforced))
            continue
        worst = 'EXPECTED' if all(s == 'EXPECTED' for _, s, _ in rows) else fn.severity
        print('  %-5s %-24s %d finding(s)  (%s)' % (worst, fn.constraint_id, len(rows), enforced))
        print('        why: %s' % fn.why)
        for finding, shown, reason in rows:
            line = '          [%s] %s: %s' % (shown, finding.target, finding.message)
            print(line + ('  <- expected: %s' % reason if reason else ''))

    if drift:
        print('\nDRIFT -- declared as expected, but no longer happening:')
        for e in drift:
            print('  %s %s (%s)' % (e.get('id'), e.get('target', '*'), e.get('reason', '')))

    print('\n%d unexpected ERROR finding(s)' % unexpected_errors)
    return 1 if unexpected_errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
