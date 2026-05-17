const assetId = ObjectId(DP_ISOLATE_ASSET_ID);
const incident = db.Incidents.findOne({ asset: assetId, endedAt: null });

if (!incident) {
  print(EJSON.stringify({
    assetId: String(assetId),
    hasIncident: false,
    inQueue: false,
    isolated: false,
    taskCount: 0,
    taskActions: [],
    assetTaskLogCount: 0,
  }));
} else {
  const taskIds = [
    ...new Set((incident.diversion || [])
      .flatMap((diversion) => [
        ...(diversion.tasks || []),
        ...((diversion.state && diversion.state.curr_tasks) || []),
      ])
      .map(String)),
  ];
  const taskObjectIds = taskIds.map((id) => ObjectId(id));
  const taskQuery = { _id: { $in: taskObjectIds } };

  print(EJSON.stringify({
    assetId: String(assetId),
    incidentId: String(incident._id),
    hasIncident: true,
    inQueue: Boolean(incident.in_queue),
    isolated: Boolean(incident.isolation_state && incident.isolation_state.isolated),
    taskIds,
    taskCount: db.Tasks.countDocuments(taskQuery),
    taskActions: db.Tasks.distinct('command.action', taskQuery),
    assetTaskLogCount: db.AssetTasksLogs.countDocuments({ incident_id: incident._id }),
  }));
}
