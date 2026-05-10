// Shared resource allocation logic for both internal and widget bookings.
// Single source of truth for "given this service at this time, can it be booked,
// and which specific resources should be claimed?"

// Algorithm:
//   1. Load the service's resource groups
//   2. For each group, load the resources in display order
//   3. For each resource, check appointment_resources for overlapping claims
//      (excluding the appointment we're checking for - matters for edits)
//   4. Pick the FIRST free resource per group (deterministic, by display order)
//   5. If any group has no free resource, return failure
//   6. Otherwise return the list of (group_id, resource_id) claims

// Time overlap rule: a claim conflicts if appointment time + duration window
// overlaps with the requested time + duration window. Resource buffer_after is
// added to the EXISTING appointment's window to enforce cleanup time.

// dbClient: a node-pg client with an open transaction (for atomic claim).

async function resolveResourceClaims(opts) {
  const {
    serviceId,
    subaccountId,
    date,            // 'YYYY-MM-DD'
    time,            // 'HH:MM'
    duration,        // minutes (number)
    ignoreAppointmentId,  // for edit/reschedule: don't count this appt's claim against itself
    dbClient
  } = opts;

  if (!serviceId || !subaccountId || !date || !time || !duration) {
    return { ok: true, claims: [], note: 'missing required fields - skipping resource check' };
  }

  // 1. Load groups for this service, ordered
  const groupsRes = await dbClient.query(
    `SELECT id, display_order
     FROM service_resource_groups
     WHERE service_id = $1 AND subaccount_id = $2
     ORDER BY display_order, id`,
    [serviceId, subaccountId]
  );

  // No groups = no resource constraints
  if (!groupsRes.rows.length) {
    return { ok: true, claims: [] };
  }

  const groupIds = groupsRes.rows.map(g => g.id);

  // 2. Load all members for these groups, joined to resources for capacity/buffer info
  const membersRes = await dbClient.query(
    `SELECT m.group_id, m.resource_id, m.display_order AS member_order,
            r.name, r.capacity, r.buffer_after, r.active
     FROM service_resource_group_members m
     JOIN resources r ON r.id = m.resource_id
     WHERE m.group_id = ANY($1::text[])
       AND r.subaccount_id = $2
     ORDER BY m.group_id, m.display_order, r.name`,
    [groupIds, subaccountId]
  );

  // Bucket members by group
  const membersByGroup = {};
  for (const m of membersRes.rows) {
    if (!membersByGroup[m.group_id]) membersByGroup[m.group_id] = [];
    membersByGroup[m.group_id].push(m);
  }

  // 3. For each group, find the first free resource
  const claims = [];
  const conflicts = [];

  for (const group of groupsRes.rows) {
    const members = (membersByGroup[group.id] || []).filter(m => m.active !== false);
    if (!members.length) {
      // Group has no members or all are inactive - treat as unsatisfiable.
      conflicts.push({
        group_id: group.id,
        attempted: [],
        reason: 'no active resources in group'
      });
      continue;
    }

    let claimedResource = null;
    const attemptedResources = [];

    for (const m of members) {
      // Time-overlap query against appointment_resources joined to appointments
      const busyRes = await dbClient.query(
        `SELECT ar.appointment_id, a.title, a.time, a.duration
         FROM appointment_resources ar
         JOIN appointments a ON a.id = ar.appointment_id
         WHERE ar.resource_id = $1
           AND a.subaccount_id = $2
           AND a.date = $3
           AND a.status != 'cancelled'
           AND ($4::text IS NULL OR a.id != $4)
           AND a.time IS NOT NULL
           AND (
             ($5::time >= a.time::time AND $5::time < (a.time::time + ((a.duration::int + $7::int) || ' minutes')::interval))
             OR
             (($5::time + ($6 || ' minutes')::interval) > a.time::time AND $5::time < a.time::time)
             OR
             ($5::time <= a.time::time AND ($5::time + ($6 || ' minutes')::interval) >= (a.time::time + (a.duration::int || ' minutes')::interval))
           )
         LIMIT $8`,
        [
          m.resource_id,
          subaccountId,
          date,
          ignoreAppointmentId || null,
          time,
          String(duration),
          parseInt(m.buffer_after) || 0,
          parseInt(m.capacity) || 1
        ]
      );

      const busyCount = busyRes.rows.length;
      const cap = parseInt(m.capacity) || 1;
      const isAvailable = busyCount < cap;

      attemptedResources.push({
        resource_id: m.resource_id,
        name: m.name,
        capacity: cap,
        busy_count: busyCount,
        available: isAvailable
      });

      if (isAvailable) {
        claimedResource = {
          group_id: group.id,
          resource_id: m.resource_id,
          name: m.name
        };
        break; // First-free strategy
      }
    }

    if (claimedResource) {
      claims.push(claimedResource);
    } else {
      conflicts.push({
        group_id: group.id,
        attempted: attemptedResources,
        reason: 'all resources busy'
      });
    }
  }

  if (conflicts.length) {
    return { ok: false, conflicts, partial_claims: claims };
  }
  return { ok: true, claims };
}

// Resolve resource claims for a GROUP booking. Same as resolveResourceClaims
// but supports two modes:
//   mode='capacity': the service's resource group has a single resource with
//     capacity >= count. Claim that one resource (capacity check accounts for count).
//   mode='separate': claim COUNT different free resources from each group.
//
// Used for couples-massage-style bookings where N clients/staff need N rooms
// (or one room with capacity for N).
async function resolveMultipleResourceClaims(opts) {
  const {
    serviceId,
    subaccountId,
    date,
    time,
    duration,
    ignoreAppointmentId,
    count,           // how many people in the group
    dbClient
  } = opts;

  if (!serviceId || !subaccountId || !date || !time || !duration || !count) {
    return { ok: true, claims: [], note: 'missing required fields - skipping' };
  }

  // Load resource groups
  const groupsRes = await dbClient.query(
    `SELECT id, display_order
     FROM service_resource_groups
     WHERE service_id = $1 AND subaccount_id = $2
     ORDER BY display_order, id`,
    [serviceId, subaccountId]
  );

  if (!groupsRes.rows.length) {
    return { ok: true, claims: [] };
  }

  const groupIds = groupsRes.rows.map(g => g.id);

  const membersRes = await dbClient.query(
    `SELECT m.group_id, m.resource_id, m.display_order AS member_order,
            r.name, r.capacity, r.buffer_after, r.active
     FROM service_resource_group_members m
     JOIN resources r ON r.id = m.resource_id
     WHERE m.group_id = ANY($1::text[])
       AND r.subaccount_id = $2
     ORDER BY m.group_id, m.display_order, r.name`,
    [groupIds, subaccountId]
  );

  const membersByGroup = {};
  for (const m of membersRes.rows) {
    if (!membersByGroup[m.group_id]) membersByGroup[m.group_id] = [];
    membersByGroup[m.group_id].push(m);
  }

  // Helper: check if a resource is free for the requested time window.
  // Returns { available: bool, busy_count: int }. busy_count is how many
  // overlapping claims already exist (used for capacity mode).
  async function checkResourceAvailable(m) {
    const busyRes = await dbClient.query(
      `SELECT COUNT(*)::int AS busy FROM appointment_resources ar
       JOIN appointments a ON a.id = ar.appointment_id
       WHERE ar.resource_id = $1
         AND a.subaccount_id = $2
         AND a.date = $3
         AND a.status != 'cancelled'
         AND ($4::text IS NULL OR a.id != $4)
         AND a.time IS NOT NULL
         AND (
           ($5::time >= a.time::time AND $5::time < (a.time::time + ((a.duration::int + $7::int) || ' minutes')::interval))
           OR
           (($5::time + ($6 || ' minutes')::interval) > a.time::time AND $5::time < a.time::time)
           OR
           ($5::time <= a.time::time AND ($5::time + ($6 || ' minutes')::interval) >= (a.time::time + (a.duration::int || ' minutes')::interval))
         )`,
      [m.resource_id, subaccountId, date, ignoreAppointmentId || null,
       time, String(duration), parseInt(m.buffer_after) || 0]
    );
    const busy = parseInt(busyRes.rows[0].busy) || 0;
    const cap = parseInt(m.capacity) || 1;
    return { busy_count: busy, capacity: cap, available: busy < cap };
  }

  // Track resources already claimed in THIS booking so we never double-pick.
  const alreadyClaimed = new Set();
  const claims = [];
  const conflicts = [];

  // For each resource group (in display order), figure out how to satisfy it.
  for (const group of groupsRes.rows) {
    const members = (membersByGroup[group.id] || []).filter(m => m.active !== false);
    if (!members.length) {
      conflicts.push({ group_id: group.id, attempted: [], reason: 'no active resources in group' });
      continue;
    }

    // AUTO-DETECT: try capacity mode first if the group has a single resource
    // with capacity >= count. Otherwise fall through to separate mode.
    const capCandidate = members.find(m => (parseInt(m.capacity) || 1) >= count && !alreadyClaimed.has(m.resource_id));
    let claimed = null;

    if (capCandidate) {
      const status = await checkResourceAvailable(capCandidate);
      if (status.busy_count + count <= status.capacity) {
        claimed = { mode: 'capacity', group_id: group.id, resource_id: capCandidate.resource_id, name: capCandidate.name, count };
        alreadyClaimed.add(capCandidate.resource_id);
        claims.push(claimed);
        continue;
      }
    }

    // Separate mode: pick `count` different free resources from this group,
    // skipping any already claimed in earlier groups for this booking.
    const groupClaims = [];
    const attempted = [];
    for (const m of members) {
      if (groupClaims.length >= count) break;
      if (alreadyClaimed.has(m.resource_id)) {
        attempted.push({ resource_id: m.resource_id, name: m.name, available: false, reason: 'already claimed by previous group' });
        continue;
      }
      const status = await checkResourceAvailable(m);
      attempted.push({ resource_id: m.resource_id, name: m.name, available: status.available });
      if (status.available) {
        groupClaims.push({ mode: 'separate', group_id: group.id, resource_id: m.resource_id, name: m.name });
        alreadyClaimed.add(m.resource_id);
      }
    }

    if (groupClaims.length === count) {
      for (const c of groupClaims) claims.push(c);
    } else {
      conflicts.push({
        group_id: group.id,
        attempted,
        reason: 'only ' + groupClaims.length + ' free of ' + count + ' needed'
      });
    }
  }

  if (conflicts.length) {
    return { ok: false, conflicts, partial_claims: claims };
  }
  return { ok: true, claims };
}


// Insert claims into appointment_resources. Caller controls the transaction.
async function persistClaims(opts) {
  const { dbClient, appointmentId, claims } = opts;
  if (!Array.isArray(claims) || !claims.length) return;
  for (const c of claims) {
    await dbClient.query(
      `INSERT INTO appointment_resources (appointment_id, resource_id, group_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [appointmentId, c.resource_id, c.group_id || null]
    );
  }
}

// Replace claims for an existing appointment (delete + insert in same caller-managed transaction).
async function replaceClaims(opts) {
  const { dbClient, appointmentId, claims } = opts;
  await dbClient.query(`DELETE FROM appointment_resources WHERE appointment_id = $1`, [appointmentId]);
  await persistClaims({ dbClient, appointmentId, claims });
}


module.exports = { resolveResourceClaims, resolveMultipleResourceClaims, persistClaims, replaceClaims };
