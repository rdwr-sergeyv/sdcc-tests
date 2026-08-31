// Shared helpers for the multi-SC escalation suites.
//
// WHY THIS FILE EXISTS
//   escalation-dedupe.spec.cjs grew its own copies of these because escalation-endpoints.spec.cjs's
//   helpers assume ONE SC per asset (info.scId / info.scName) and build a one-entry topology. A
//   second multi-SC suite (escalation-tail-leg.spec.cjs) needed the same five, and a third copy is
//   where drift starts -- so they were lifted here VERBATIM on 2026-08-30, comments included, and
//   both suites now require them. Nothing below was rewritten; the only additions are
//   divertingLegs() and communityTasksBySc(), which the tail-leg suite needs and dedupe does not.
//
//   `login`, `mongoJson` and `waitFor` still come from ../dp-isolate/dp-isolate-helpers.cjs.

const { expect } = require('playwright/test');
const { mongoJson, waitFor } = require('../dp-isolate/dp-isolate-helpers.cjs');

/** The asset plus EVERY SC it diverts to -- its site's SC and each additional SC. */
function multiScAssetInfo(name) {
  return mongoJson(`(() => {
    const a = db.Assets.findOne({ name: '${name}', type: 'network' });
    if (!a) throw new Error('asset not found: ${name}');
    const sd = (a.asset_site_data || [])[0];
    const site = db.AccountSites.findOne({ _id: sd.account_site });
    const account = db.Accounts.findOne({ _id: a.account });

    const zones = {};
    db.DPZones.find({}).forEach((z) => { zones[String(z._id)] = z; });
    const closure = [];
    let cur = zones[String(account.zone)];
    while (cur) { closure.push(String(cur._id)); cur = cur.fail_over ? zones[String(cur.fail_over)] : null; }

    const scIds = [site.sc_id].concat((sd.asset_additional_site || []).map((x) => x.sc_id));
    const scs = scIds.map((id) => {
      const sc = db.ScrubbingCenters.findOne({ _id: id });
      const esc = sc.escalates_to ? db.ScrubbingCenters.findOne({ _id: sc.escalates_to }) : null;
      return {
        scId: String(sc._id),
        scName: sc.name,
        escalatesTo: esc ? esc.name : null,
        devices: (sc.management_devices || [])
          .filter((d) => ['radware-defensepro', 'router-out', 'router-in'].includes(d.role))
          .map((d) => ({
            id: String(d.unique_id),
            role: d.role,
            inZone: d.role !== 'radware-defensepro' || closure.includes(String(d.zone)),
            // which routers this DP is actually cabled to. A DP entry pairs an edge router with an
            // access router, and the activate validator refuses a topology that selects an AR the
            // DP has no interface toward: "One of the interfaces (access or edge router) is
            // missing for DP: <name>".
            routerOuts: [...new Set((d.interfaces || []).map((i) => String(i.router_out)))],
            routerIns: [...new Set((d.interfaces || []).map((i) => String(i.router_in)))],
          })),
      };
    });

    return {
      id: String(a._id),
      status: a.status,
      address: String(a.address),
      mask: Number(a.mask) || 24,
      zoneId: String(account.zone),
      scs,
    };
  })()`);
}

/** One topology entry per SC the asset diverts to.
 *
 * Routers are selected by FOLLOWING THE CABLING of the DPs we picked, not by document order. An SC
 * can carry a router-out that no DP is wired to -- NEW_SC has one, `ROut1`, left over from whatever
 * it was originally reserved for -- and selecting it makes the activate fail validation with "One
 * of the interfaces (access or edge router) is missing for DP". Ordering happened to hide this on
 * NEW-LAB-2, where the first router-out is a real AR.
 */
function buildMultiScTopology(info, dpCount) {
  return info.scs.map((sc) => {
    let picked = 0;
    const chosenDps = [];
    const devices = sc.devices.map((d) => {
      if (d.role === 'radware-defensepro') {
        const selected = d.inZone && picked < dpCount;
        if (selected) { picked += 1; chosenDps.push(d); }
        return {
          _oid: d.id, type: 'dp', selected, implicit: false,
          'dp-subnet': info.address, 'dp-mask': info.mask,
        };
      }
      return { _oid: d.id, type: d.role, selected: false, implicit: false };
    });

    const wiredOut = new Set(chosenDps.flatMap((d) => d.routerOuts));
    const wiredIn = new Set(chosenDps.flatMap((d) => d.routerIns));
    devices.forEach((entry) => {
      if (entry.type === 'router-out') entry.selected = wiredOut.has(entry._oid);
      if (entry.type === 'router-in') entry.selected = wiredIn.has(entry._oid);
    });

    if (![...wiredOut].length) {
      throw new Error(`${sc.scName}: the DPs picked are wired to no access router`);
    }
    return { sc: { _oid: sc.scId }, line_type: 'DDOS', sc_prepend: 0, zone: { _oid: info.zoneId }, devices };
  });
}

function activeDiversionScs(assetId) {
  return mongoJson(`(() => {
    const i = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    if (!i) return [];
    return (i.diversion || [])
      .filter((d) => !(d.state || {}).deactivated)
      .map((d) => (db.ScrubbingCenters.findOne({ _id: d.sc_id }) || {}).name)
      .sort();
  })()`);
}

function assetStatus(assetId) {
  return mongoJson(`String((db.Assets.findOne({ _id: ObjectId('${assetId}') }) || {}).status)`);
}

/** Wait until the action has actually LANDED, not merely left the queue.
 *
 * Two things had to be learnt the hard way here, both on 2026-08-26:
 *
 *  1. Task documents carry no incident or asset reference at all -- their fields are _id, command,
 *     createdAt, progress, status, type, modifiedAt, dependencies, startedAt, endedAt, message. A
 *     first version counted `db.Tasks` by `incident_id`, matched nothing, declared "idle" the
 *     instant the activate returned and fired the escalate mid-flight. The API rightly refused it
 *     (`ValueError("Incident status doesn't match your action.")`, 500) and left the incident
 *     wedged at `created`.
 *  2. `in_queue` alone is still too early. It clears well before the incident reaches `activated`,
 *     so a deactivate sent on that signal arrives while the asset is `activating` and is refused
 *     with "Asset status is not suitable for your action". Measured on four assets: each looked
 *     stuck at `activating`/`created` and each reached `pending`/`activated` on its own afterwards.
 *
 * So wait for the incident to leave `created` and the asset to leave `activating` as well. `pending`
 * is a normal diverted state, not a transitional one.
 */
async function settle(assetId) {
  await waitFor(() => (mongoJson(`(() => {
    const inc = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    if (!inc) return true;
    if (inc.in_queue === true) return false;
    if (String(inc.status) === 'created') return false;
    const a = db.Assets.findOne({ _id: ObjectId('${assetId}') }, { status: 1 });
    return String(a.status) !== 'activating';
  })()`) ? true : null), { timeoutMs: 300000 });
}

/** Every ACTIVE leg of the asset's open incident, with its head/tail relation.
 *
 * `sc_connected` is the whole point: a leg with it is a TAIL announcing alongside the head named in
 * it, a leg without it is a HEAD. update_incident selects heads by the ABSENCE of the field
 * (sdcc/common/util/diversion.py:2874), so the two take different paths through it -- which is why
 * a leg count alone cannot say what shape an escalate left behind.
 */
function divertingLegs(assetId) {
  return mongoJson(`(() => {
    const i = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    if (!i) return [];
    return (i.diversion || [])
      .filter((d) => !(d.state || {}).deactivated)
      .map((d) => ({
        scId: String(d.sc_id),
        scName: (db.ScrubbingCenters.findOne({ _id: d.sc_id }) || {}).name,
        connectedTo: ((d.state || {}).sc_connected || []).map(String),
      }))
      .sort((a, b) => (a.scName < b.scName ? -1 : 1));
  })()`);
}

/** Announcement tasks for ONE asset since `sinceIso`, grouped by SC and action.
 *
 * Returns { "<SC name>|<action>": [device names, sorted] }, covering add_community /
 * remove_community (the escalation announcement, 19894:911) and add_bgp_adv / remove_bgp_adv (the
 * additional-SC advertisement, which only a real head/tail pair makes non-empty).
 *
 * Four things this must not get wrong, each already paid for once:
 *
 *  1. The action is `command.action`, NOT `command.name` -- there is no `name` key on a task command
 *     and a query on one returns nothing, which reads as "no tasks were created" rather than as a
 *     broken query. Measured 2026-08-30.
 *  2. `command.device` is an ObjectId. String(...) both sides, or the join silently matches nothing.
 *  3. Device NAMES repeat across SCs. NEW-LAB, NEW-LAB-2, NEW_SC and SCRUBBING_1 each hold their own
 *     document for the same two physical access routers, so the SC comes from which SC owns the
 *     device ID -- never from the name.
 *  4. Old runs look identical to new ones. Scoped by asset AND by time: matching a device name
 *     without a date once mixed a June run into an August one and manufactured a phantom bug.
 */
function announcementTasks(assetId, sinceIso) {
  return mongoJson(`(() => {
    const owner = {};
    db.ScrubbingCenters.find({}, { name: 1, management_devices: 1 }).forEach((sc) => {
      (sc.management_devices || []).forEach((d) => {
        // ifaces decides whether a zero-metric render is a fault or the expected shape: a
        // router-out with no interfaces feeds no DP and has nothing to say. NEW_SC's Cisco ROut1
        // is exactly that, left in place and unused on purpose (Lab-3SC-Scenario 4b).
        owner[String(d.unique_id)] = {
          scName: sc.name, deviceName: d.name, ifaces: (d.interfaces || []).length,
        };
      });
    });
    const out = {};
    db.Tasks.find({
      createdAt: { $gte: ISODate('${sinceIso}') },
      'command.asset': ObjectId('${assetId}'),
      'command.action': { $in: ['add_community', 'remove_community',
                                'add_bgp_adv', 'remove_bgp_adv'] },
    }).forEach((t) => {
      const o = owner[String(t.command.device)]
        || { scName: '(unknown SC)', deviceName: '(unknown)', ifaces: 0 };
      const key = o.scName + '|' + t.command.action;
      // metrics is carried because a task's EXISTENCE proves nothing about its render. The
      // community statements are one per interface-derived metric, so metrics: [] is a task that
      // reports success and writes not a line -- measured at NEW_SC on 2026-08-30, 3 bytes against
      // NEW-LAB-2's 561, and true unnoticed since the fixture was built on 08-23. Assert on this,
      // never on the bare presence of the task.
      out[key] = (out[key] || []).concat([{
        device: o.deviceName,
        ifaces: o.ifaces,
        metrics: (((t.command.args || {}).metrics) || []).length,
      }]);
    });
    // one entry per device -- the question is WHICH announcers were configured and whether each
    // actually rendered, not how many tasks each got
    Object.keys(out).forEach((k) => {
      const best = {};
      out[k].forEach((e) => {
        if (!(e.device in best) || e.metrics > best[e.device].metrics) best[e.device] = e;
      });
      out[k] = Object.keys(best).sort().map((d) => best[d]);
    });
    return out;
  })()`);
}

/** Every task created for this asset since `sinceIso`, grouped by SC and action.
 *
 * Unfiltered by action on purpose: this is the counter used to ask whether a leg was submitted
 * once or twice, and pre-selecting actions would decide the answer before measuring it. The SC
 * comes from which SC owns the device id, never from the device name -- four SCs in this lab hold
 * their own document for the same two physical access routers.
 */
function taskCountsBySc(assetId, sinceIso) {
  return mongoJson(`(() => {
    const owner = {};
    db.ScrubbingCenters.find({}, { name: 1, 'management_devices.unique_id': 1 }).forEach((sc) => {
      (sc.management_devices || []).forEach((d) => { owner[String(d.unique_id)] = sc.name; });
    });
    const out = {};
    db.Tasks.find({
      createdAt: { $gte: ISODate('${sinceIso}') },
      'command.asset': ObjectId('${assetId}'),
    }).forEach((t) => {
      const key = (owner[String(t.command.device)] || '(unknown SC)') + '|' + t.command.action;
      out[key] = (out[key] || 0) + 1;
    });
    return out;
  })()`);
}

/** The id of the asset's open incident -- an Update is POSTed to /api/incident/<id>. */
function openIncidentId(assetId) {
  return mongoJson(`(() => {
    const i = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    return i ? String(i._id) : null;
  })()`);
}

/** An SC was told to demote AND the instruction actually rendered.
 *
 * The second half is the point. A community task reports success whether or not it writes a line,
 * and the statements are one per interface-derived metric -- so metrics: [] is a task that exists,
 * succeeds, and configures nothing. Measured at NEW_SC on 2026-08-30: 3 rendered bytes against
 * NEW-LAB-2's 561, true since the fixture was built on 08-23 and invisible to every assertion
 * anyone had written. Root cause was a cloned DP storing interfaces[].router_out as an ObjectId
 * where the product stores a string, so validate_next_hop_interfaces silently rejected it
 * (tools/probe_metrics.py; repair in tools/lab_fix_clone_iface_refs.py).
 *
 * Scoped to WIRED routers-out: one with no interfaces feeds no DP and has nothing to render, which
 * is the expected shape for NEW_SC's inert Cisco ROut1. The first assertion stops that scoping from
 * turning an SC with NO wired announcer into a silent pass.
 *
 * Asserting on task presence alone is what let the blank render stand for a week. Do not weaken it.
 */
function expectDemoted(tasks, scName, action) {
  const entries = tasks[`${scName}|${action}`];
  expect(entries, `${scName} must get a ${action} task`).toBeTruthy();

  const wired = entries.filter((e) => e.ifaces > 0);
  expect(wired.length,
    `${scName}: no WIRED router-out received a ${action} task at all`).toBeGreaterThan(0);

  const blank = wired.filter((e) => e.metrics === 0).map((e) => e.device);
  expect(blank,
    `${scName}: ${action} carries no metrics on ${blank.join(', ')} -- the task will report success `
    + 'and render nothing. A wired router-out with zero metrics means its DPs failed '
    + 'validate_next_hop_interfaces; run tools/probe_metrics.py in a backend container.')
    .toEqual([]);
}

/** Wait until the asset is genuinely re-activatable, not merely "not activating".
 *
 * A cleanup deactivate returns 200 while the asset sits at `deactivating` for a few seconds, so a
 * suite starting straight after another one finds it mid-teardown and fails its precondition. That
 * cost a whole folder run on 2026-08-31 -- "test needs asset_5 undiverted, it is deactivating",
 * 5 failed / 12 did not run, none of it a product fault.
 *
 * Distinct assets per suite is the real fix and is in place; this is the belt to that pair of
 * braces, because assets get shared again the moment someone adds a suite.
 */
async function waitUntilReady(assetName, ready) {
  await waitFor(() => {
    const status = mongoJson(`String((db.Assets.findOne({ name: '${assetName}' }) || {}).status)`);
    return ready.includes(status) ? true : null;
  }, { timeoutMs: 300000 });
}

module.exports = {
  multiScAssetInfo,
  buildMultiScTopology,
  activeDiversionScs,
  assetStatus,
  settle,
  divertingLegs,
  announcementTasks,
  taskCountsBySc,
  openIncidentId,
  expectDemoted,
  waitUntilReady,
};
