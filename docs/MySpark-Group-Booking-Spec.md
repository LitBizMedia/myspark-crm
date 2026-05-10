# MySpark+ Group Booking Specification

Last updated: May 10, 2026

This document specifies the group booking feature for service calendars. A group booking is a single appointment shared by multiple clients and assigned to multiple staff members. Use cases include couples massage, group consultations, partner training sessions.

When building any future feature that touches group bookings, follow this doc. When in doubt, this doc wins.

The principle: one appointment, multiple clients, multiple staff, single payment.

## What is NOT a group booking

- Classes (1 staff, N participants, fixed sessions). Already exists, separate concept.
- Sequential multi-stage services (1 client, M staff in order). Out of scope, future feature.
- Multiple separate bookings at the same time. Each appointment stands alone.

A group booking is specifically: ad-hoc, multiple staff serving multiple clients in parallel for the same service.

## Scope decisions (locked May 10, 2026)

1. Group bookings are flagged at the service level via `group_capable = true`
2. Each group-capable service has min/max client counts and an exact staff count
3. Service has an eligible-staff pool; bookings can only assign from that pool
4. Staff count is EXACT (booking must have exactly that many staff, not more, not less)
5. Client count uses min/max range (e.g., couples massage min=2, max=2; group consult 1-4)
6. The booking is ONE appointment record with multi-client and multi-staff associations
7. Staff auto-assigns from the eligible pool based on availability; clients are not paired with specific staff
8. Resources auto-assign based on service config (capacity mode OR separate resources mode)
9. Cancellation and reschedule are atomic across the group
10. Single payment from primary booker, single group price
11. Email confirmation to each client
12. Internal calendar shows booking on every assigned staff's column with group icon

## Data Model

### `services` table additions

```sql
ALTER TABLE services ADD COLUMN group_capable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE services ADD COLUMN group_staff_count INT;
ALTER TABLE services ADD COLUMN group_eligible_staff JSONB NOT NULL DEFAULT '[]';
ALTER TABLE services ADD COLUMN group_size_min INT;
ALTER TABLE services ADD COLUMN group_size_max INT;
ALTER TABLE services ADD COLUMN group_price NUMERIC(10,2);
ALTER TABLE services ADD COLUMN group_resource_mode TEXT
  CHECK (group_resource_mode IN ('capacity', 'separate') OR group_resource_mode IS NULL);
```

- `group_capable`: turns this service into a group bookable service
- `group_staff_count`: EXACT number of staff required per booking (e.g., 2 for couples massage)
- `group_eligible_staff`: array of staff IDs that can be assigned to this service. The system picks from this pool only.
- `group_size_min`: min clients required (e.g., 2 for couples; 1 for "doctor + nurse w/ patient")
- `group_size_max`: max clients allowed
- `group_price`: single price for the entire group
- `group_resource_mode`:
  - `'capacity'`: claim ONE resource with `capacity >= group_size`
  - `'separate'`: claim group_size_at_booking DIFFERENT resources from the linked resource group(s)

When `group_capable = false`, the other group columns are ignored.

### `appointment_clients` table (NEW)

```sql
CREATE TABLE appointment_clients (
  appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (appointment_id, contact_id)
);
CREATE INDEX idx_apptclients_appt ON appointment_clients(appointment_id);
CREATE INDEX idx_apptclients_contact ON appointment_clients(contact_id);
```

- `is_primary`: TRUE for the booker who pays. Exactly one row per appointment marked primary.

### `appointment_staff` table (NEW)

```sql
CREATE TABLE appointment_staff (
  appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (appointment_id, staff_id)
);
CREATE INDEX idx_apptstaff_appt ON appointment_staff(appointment_id);
CREATE INDEX idx_apptstaff_staff ON appointment_staff(staff_id);
```

### Backwards compatibility

The existing `appointments.contact_id` and `appointments.assigned_to` columns stay populated:
- For non-group bookings: behave exactly as today
- For group bookings: `contact_id` = primary booker, `assigned_to` = first staff (display_order 0)

This keeps old reads working unchanged. New reads can JOIN to the new tables to get all clients/staff.

## Booking Flow

### Internal booking (dashboard)

1. Staff opens "+ New Appointment" modal
2. Picks a service from the dropdown
3. If service is group_capable, the form expands:
   - Multi-select chip picker for clients (min = group_size_min, max = group_size_max)
   - Multi-select chip picker for staff (must = group_staff_count exactly, only shows eligible_staff pool)
   - Resource auto-assignment shown as read-only display
   - Save button disabled until both client count and staff count meet requirements
4. Staff fills in primary booker's contact (first chip), optionally adds more clients
5. Staff selects exactly group_staff_count staff from the eligible pool
6. On save: create appointment, populate appointment_clients + appointment_staff, claim resources, log audit

### Widget booking

1. Patient picks a group-capable service from the widget catalog
2. Widget shows count selector ("How many people?" min=group_size_min, max=group_size_max)
3. Patient picks date and time; backend filters slots where exactly group_staff_count staff from eligible_staff pool are simultaneously free
4. Patient enters info for self (primary booker), then "+ Add another person" for each additional client up to selected count
5. All clients see contact form with name + email + phone
6. Patient pays the group price (single charge from primary booker)
7. On submit: appointment created, all clients linked, staff auto-assigned from eligible pool, resources claimed
8. Each client gets a confirmation email

If the eligible_staff pool doesn't have group_staff_count members free at any time on the chosen date, the widget shows no slots. No fallback to non-eligible staff.

## Calendar Rendering

A group booking with 2 staff appears on:
- Each assigned staff's column at the same time
- Full appointment card on each staff's column (decision: render in full, simpler than thin placeholders)
- A small "group" icon (👥 or similar) on each card to indicate it's a shared booking
- Clicking any card opens the same appointment modal showing all clients and staff

## Resource Allocation

### Capacity mode
- Service has 1 resource group with 1 resource of capacity >= group_size
- Booking claims that one resource (capacity counter goes up by group_size)
- Conflict check: existing claims for this resource don't exceed capacity

### Separate mode
- Service has 1 resource group with M resources (M >= group_size_max)
- Booking claims N different resources (N = group_size at booking time)
- Conflict check: standard "first free in display order" picks N free resources

The existing `resolveResourceClaims` helper extends to handle both modes. Capacity mode is already supported. Separate mode needs a new option to pick N (instead of 1) resources from a group.

## Cancellation and Reschedule

### Cancellation
- Group booking deletes all linked rows (CASCADE handles appointment_clients and appointment_staff)
- All resource claims released
- Cancel emails to all clients

### Reschedule
- Move time = move whole booking
- Pre-flight: verify ALL N staff are free at new time AND resources still claim-able
- If any conflict: 409, no partial moves
- If clean: update appointment time, replace resource claims

### Edit (other fields)
- Adding/removing a client mid-flight: only allowed in dashboard, with warning
- Adding/removing staff mid-flight: same
- Changing the service: blocked if group_capable changes (would re-shape the booking)

## Payment

Single payment record per group booking:
- `total` = service.group_price (overrides individual per-person pricing)
- `paymentMethod` = whatever primary booker used
- `contactId` = primary booker
- `staffId` = first assigned staff (audit trail; physical service splits between all)
- `tipStaffId` = configurable; for now, defaults to first staff (TBD: split tips evenly?)
- New field on payments record: `appointment_clients` (JSONB array of client IDs in this group)

For payroll, the business divides as they see fit. We don't auto-split tips or revenue.

## Stage Plan

### Stage 1: Schema + helpers (~1 hour)
- Migration: services columns, appointment_clients, appointment_staff
- Migration Lambda + SQL
- Extend `resolveResourceClaims` for capacity vs separate mode (already supports capacity, add multi-pick)
- Update data-load to return appointment_clients + appointment_staff joined to appointments

### Stage 2: Service config UI (~2 hours)
- New "Group Booking" tab in service edit modal (visible only when toggle is on)
- Toggle: group_capable
- Fields:
  - group_staff_count (number input, default 2, min 2)
  - group_eligible_staff (multi-select chip picker from active staff)
  - group_size_min (number input, default 2)
  - group_size_max (number input, default 2)
  - group_price (numeric)
  - group_resource_mode (radio: capacity OR separate)
- Validation:
  - group_staff_count >= 2
  - eligible_staff list has at least group_staff_count members
  - group_size_min <= group_size_max
  - group_size_min >= 1
- Save endpoint: existing services-upsert extended

### Stage 3: Internal booking (~3 hours)
- Appointment modal detects group_capable service, shows multi-client and multi-staff slots
- Staff auto-suggest dropdown per slot (filters by who's available at that time)
- Resource preview shows what will be claimed
- Save: create appointment, populate join tables, claim resources, single payment record
- Calendar: render booking on every assigned staff's column
- Edit modal handles existing group bookings: shows all clients/staff, allows additions/removals

### Stage 4: Widget booking (~2.5 hours)
- Booking widget detects group_capable service
- New step in flow: "How many people?" selector
- Multi-client info form
- Backend: extend booking-availability to filter slots by multi-staff availability
- Backend: extend booking-submit to handle group submissions
- Single Square charge for the whole group
- Confirmation emails to all clients

### Stage 5: Polish (~2 hours)
- Group reschedule via email link (move whole booking)
- Group cancellation via email link (cancel all, refund logic)
- Edge cases: one client cancels (TBD: cancel all? or detach? for now: cancel all per spec)
- Audit logs include all clients and staff
- Calendar UI: hover preview shows all participants

## Total Estimate

10-12 hours across multiple sessions.

## Recommended Approach

Stages 1-3 first, validate with real internal use. Stages 4-5 once internal flow is proven.

## Files Created/Modified

### Stage 1
- `sql/2026-05-10-group-booking.sql` (NEW)
- `api-aws/_migrations/migration-group-booking.js` (NEW)
- `lib-aws/resource-allocation.js` (extend for separate-mode multi-pick)
- `api-aws/subaccount/data-load.js` (return appointment_clients, appointment_staff)

### Stage 2
- `index.html` (service modal extended for group config)

### Stage 3
- `index.html` (appointment modal multi-client/staff, calendar rendering)
- `api-aws/subaccount/appointments-upsert.js` (handle group payload)

### Stage 4
- `api-aws/booking/booking-availability.js` (multi-staff slot filtering)
- `api-aws/booking/booking-submit.js` (handle group payload)
- `s3://myspark-booking-widget/booking-widget.html` (multi-client form)

### Stage 5
- `api-aws/booking/booking-reschedule.js` (group reschedule)
- `api-aws/booking/booking-cancel.js` (group cancel)

## Open Questions

These were resolved by the May 10, 2026 design session:

- **Q: Same staff or different staff?** → Different staff (auto-assigned, not paired with specific clients)
- **Q: Same service or mixed?** → Same service (Sub-flavor A only)
- **Q: One pricing or split?** → Single group price, business divides for payroll
- **Q: Calendar render?** → Full card on every staff's column with group icon
- **Q: One booking or N?** → ONE booking with multi-client/multi-staff joins
- **Q: Cancel atomic?** → YES, cancel cascades to all
- **Q: Resource: capacity vs separate?** → Configurable per service

## Future Considerations (out of scope)

- Sequential staff stages (dental scenario, deferred)
- Mixed services (different services per client in same group)
- Per-client payment splits
- Per-client tip routing (tips to specific staff)
- Group-only discount codes
- Recurring group bookings (book a couple's massage every 2 weeks)
