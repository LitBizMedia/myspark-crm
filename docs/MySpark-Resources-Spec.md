# MySpark+ Resources & Rooms Specification

Last updated: May 8, 2026 (initial design)

This document specifies the rooms and resources feature for service calendars. Rooms are physical spaces (treatment room, sauna). Resources are equipment (laser, hydrafacial unit, IV chair). Both are unified under a single "resources" concept with a type discriminator.

When building any future feature that touches resource availability, follow this doc. When in doubt, this doc wins.

The principle: a resource is a finite shared asset. If the resource is occupied, no booking can claim it for that time window, regardless of whether staff is free.

## Concepts

### Resource
A finite asset that can be assigned to an appointment. Examples: sauna, treatment room A, hydrafacial machine, IV chair. Defaults to capacity 1 (one appointment at a time). Higher capacity allowed for shared spaces (yoga studio for 12).

### Resource Group
A logical OR within service requirements. A service might need "any treatment room (A or B)" plus "the hydrafacial machine." That's two groups. Each group has 1+ resources; only one resource per group must be free for the booking to succeed.

### Service Resource Requirement
A service can declare 0+ resource groups it needs. A resource group is satisfied when at least one resource in the group is free for the appointment's time window.

### Resource Claim
When an appointment is created, it claims one resource from each required group. The claim is stored on the appointment. Time window of the claim equals the appointment's start time + duration + buffer_after of the resource.

## Schema

### `resources` table

```sql
CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'room'
    CHECK (type IN ('room', 'equipment', 'other')),
  capacity INT NOT NULL DEFAULT 1,
  buffer_after INT NOT NULL DEFAULT 0,  -- minutes for cleaning/turnover
  active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_resources_subaccount ON resources(subaccount_id);
```

### `service_resource_groups` table

```sql
CREATE TABLE service_resource_groups (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  subaccount_id TEXT NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  label TEXT,  -- e.g., "Treatment Room", "Equipment"
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_srg_service ON service_resource_groups(service_id);
```

### `service_resource_group_members` table

```sql
CREATE TABLE service_resource_group_members (
  group_id TEXT NOT NULL REFERENCES service_resource_groups(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, resource_id)
);
```

### `appointment_resources` table

```sql
CREATE TABLE appointment_resources (
  appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  group_id TEXT,  -- nullable; null when manually assigned outside any group
  PRIMARY KEY (appointment_id, resource_id)
);

CREATE INDEX idx_apptres_resource ON appointment_resources(resource_id);
```

## Booking Logic

### Availability check

When a slot is requested for a service with resource requirements:

1. Compute the slot's time window: start_time, start_time + duration + max(resource buffer_after across all required resources)
2. For each resource group on the service:
   a. For each resource in the group, query existing appointments via appointment_resources
   b. A resource is "free" if no overlapping claims, with cancelled appointments excluded
   c. If the resource has capacity > 1, count current claims and compare
3. A slot is bookable only if every group has at least one free resource
4. Auto-assign: pick the first free resource per group (alphabetical for tiebreaker, then display_order)

### Booking submission

1. Validate slot via the availability check
2. Create appointment row (existing flow)
3. For each required group, INSERT into appointment_resources with the auto-assigned resource_id
4. All in the same DB transaction. Rollback if any insert fails.

### Class sessions

Classes use resources too. Class capacity is for participants (already exists). The class session itself claims resources for its full duration. So a yoga class "fitness studio room" claim runs for the whole session window. Multiple participants share that single class claim.

### Race conditions

Two booking submissions for the same slot+resource happening concurrently must NOT both succeed. The appointment_resources INSERT is the gating operation. If both transactions try to claim the same resource for overlapping times, the conflict check inside the transaction catches one and rolls back. Use SERIALIZABLE isolation OR an advisory lock keyed on resource_id during the booking transaction.

### Resource conflicts in the UI

Extend the existing apptConflicts model (currently lists staff/blackout/cap conflicts) to include `resource_unavailable` with metadata: which resource, which time window. Staff can ack and override the same way they ack staff conflicts.

## Build Plan: 5 Stages

### Stage 1: Foundation (2-3 hours)

**Goal:** Resources can be created and managed in the dashboard. No booking integration.

**Deliverables:**
- Schema migration: `resources`, `service_resource_groups`, `service_resource_group_members`, `appointment_resources` tables
- 4 Lambdas: resources-list, resources-upsert, resources-delete, resources-reorder (mirror service_addons pattern)
- New "Resources" page in the dashboard, accessible from Settings or from the Services page
- Resources CRUD: name, type (room/equipment/other), capacity, buffer_after (minutes), active toggle, notes, drag-to-reorder
- data-load.js returns `resources: [...]` array

**NOT in Stage 1:**
- Service linking (Stage 2)
- Booking integration (Stage 3)
- Calendar resource view (Stage 5)

### Stage 2: Service-resource linking (1-2 hours)

**Goal:** Staff can declare which resources a service needs.

**Deliverables:**
- New "Resources" tab in the service edit modal (alongside Details, Variations, Add-ons, Sessions)
- UI: list of resource groups for this service. Each group has a label and a multi-select of resources. "+Add Group" button creates a new group.
- 2 Lambdas: service-resource-groups-upsert (handles group + members in one call), service-resource-groups-delete
- Visual hint on service: "This service needs: any of [Treatment Room A, B] + Hydrafacial Machine"

**NOT in Stage 2:**
- Booking enforcement (Stage 3)

### Stage 3: Booking integration (internal) (2-3 hours)

**Goal:** Internal appointment booking respects resource availability and auto-assigns.

**Deliverables:**
- Extend availability lookup helpers to include resource availability check
- Extend `checkApptConflict` to detect `resource_unavailable` cases
- Extend the conflict panel to show resource conflicts with the same ack-and-override pattern
- `appointments-upsert` Lambda: when service has resource groups, auto-assign + INSERT into appointment_resources
- Internal modal Resources section: shows which resources are auto-assigned (read-only by default; "Override" button lets staff manually swap)
- Race-condition: serializable transaction OR advisory lock during the upsert

**NOT in Stage 3:**
- Booking widget enforcement (Stage 4)

### Stage 4: Booking widget integration (1-2 hours)

**Goal:** Patient-facing widget refuses slots where resources aren't free.

**Deliverables:**
- Extend booking-availability Lambda to factor in resource availability (returns slots where ALL resource groups can be satisfied)
- Extend booking-submit Lambda to claim resources atomically per the booking flow
- Booking widget UI: no change visible to patients; slots they see are simply pre-filtered

### Stage 5: Calendar resource view (2-3 hours)

**Goal:** Optional "Resource view" mode shows resources as columns instead of staff.

**Deliverables:**
- New view selector: "By Staff" (default) | "By Resource"
- When "By Resource" is active, columns are resources, appointments shown under their claimed resource
- Filter to "all resources" or specific type (rooms only, equipment only)
- Maintains week/day modes
- Useful for clinics asking "which rooms are open Friday at 3?"

## Open Decisions Captured

The following design decisions were made on May 8, 2026:

1. **AND/OR semantics:** YES support both. Multiple groups = AND. Multiple resources within a group = OR.
2. **Auto-assign vs staff-pick:** Auto-assign by default, staff can override.
3. **Resource conflicts UI:** Extend existing conflict panel (consistent with staff conflicts).
4. **Capacity beyond 1:** YES support. Default 1. Higher allowed for shared spaces.
5. **Buffer time:** YES, resources have their own `buffer_after` for cleaning/turnover, separate from staff buffer.

## Out of Scope (For Now)

- Resource calendars per resource (beyond Stage 5 view)
- Resource sharing across multiple subaccounts (each subaccount has its own resources)
- Resource booking by patients directly (patient picks "I want sauna" rather than "I want sauna service" — different UX flow, defer)
- Capacity ladders (e.g., sauna seats 4 max with 30-min sessions but sessions can overlap with rest periods) — too complex for v1
- Equipment maintenance schedules / unavailability windows — defer (workaround: deactivate resource temporarily)

## Tomorrow's Starting Point

Begin with Stage 1 ONLY. Reasons:

1. Schema + CRUD is foundation. Everything depends on it.
2. Building a real resource (e.g., your client's sauna) makes the booking integration questions concrete.
3. Stage 1 is shippable on its own. Staff can manage resources even if booking doesn't enforce yet.
4. Once you have real data in the resources table, edge cases for stages 2-5 become obvious.

Stage 1 plan:
- 30 min: schema migration + 4 Lambdas
- 30 min: data-load.js returns resources
- 1-2 hours: dashboard Resources page (list + add/edit modal + reorder)
- Total: 2-3 hours

Stage 2-5 land on subsequent days as you have time.

## Files to Create/Modify

### Stage 1
- `sql/2026-05-XX-resources.sql` (new)
- `api-aws/_migrations/migration-resources.js` (new)
- `api-aws/subaccount/resources-list.js` (new)
- `api-aws/subaccount/resources-upsert.js` (new)
- `api-aws/subaccount/resources-delete.js` (new)
- `api-aws/subaccount/resources-reorder.js` (new)
- `api-aws/subaccount/data-load.js` (modify: return resources)
- `index.html` (modify: Resources page UI, navigation entry)

### Stages 2-5
Mapped per stage above. Will be detailed when each stage starts.
