# Reschedule Rewrite Plan

Created: May 19, 2026
Estimated total: 2-3 hours across 5 stages

## The Problem

Today, when a patient reschedules, the existing appointment row gets mutated. Date/time change, status flips to 'rescheduled'. One row, original time lost.

Consequences:
- Cannot answer "how many reschedules per month" without parsing date-change events
- Original time slot disappears from the calendar (the row moved)
- Audit log shows generic appointment.update, not a reschedule event
- 'rescheduled' as a status is a workaround, not a real concept (the new appointment is scheduled, not rescheduled)

## The Fix

Reschedule creates a NEW appointment row with status='scheduled' and a `rescheduled_from_id` FK pointing to the original. The original row stays in place with status='rescheduled' (which now correctly means "this slot was abandoned because the patient moved").

## Stages

### Stage 1: Schema migration (15 min, low risk)

Add `rescheduled_from_id UUID REFERENCES appointments(id) ON DELETE SET NULL` to the appointments table. Nullable. No backfill needed.

Verification: query confirms column exists, FK works, existing rows untouched.

### Stage 2: Backend Lambda new endpoint (45 min, medium risk)

Create `api-aws/subaccount/appointments-reschedule.js`. Behavior:

1. Accept { original_appointment_id, new_date, new_time, new_duration?, notes? }
2. Lookup original appointment, verify ownership (subaccount_id matches auth)
3. Run conflict check on new slot using existing isActive filter
4. In a transaction:
   - Insert new appointment row, copying contact_id, service_id, assigned_to, etc. from original. Set status='scheduled', rescheduled_from_id=original.id
   - Update original row: status='rescheduled'
5. Audit log: action='subaccount.appointment.reschedule', metadata={ original_id, new_id, old_date, new_date }
6. Return new appointment row

Decision points to confirm before building:
- Should the new appointment get a new payment record, or link to the original's payment? (Recommendation: link to original. Patient already paid.)
- Should confirmation email fire for the new appointment? (Recommendation: yes, with subject "Appointment Rescheduled" not "Appointment Booked".)
- Should the original appointment_clients/staff/resources rows clone to the new one for group bookings? (Recommendation: yes, full clone.)

### Stage 3: Frontend reschedule action (45 min, medium risk)

Add "Reschedule" button to the appointment edit modal. Distinct from "Save" which only edits in-place.

Clicking Reschedule:
1. Opens a date/time picker (reuse existing calendar slot picker if possible)
2. Confirms the new slot
3. Calls the new /api/subaccount/appointments-reschedule endpoint
4. On success, closes modal, refreshes calendar, toast "Appointment rescheduled to <new date>"

Edge case: editing date/time directly in the modal should NOT silently become a reschedule. Force user through the Reschedule button. The direct edit fields stay for minor changes (notes, location, status).

### Stage 4: Calendar rendering for rescheduled originals (20 min, low risk)

Rescheduled original rows should still render on the calendar, but visually distinct (strikethrough, dimmed) so staff see "this slot was abandoned because patient moved to <new date>".

On hover or click, show a "Rescheduled to <new date>" indicator linking to the new appointment.

### Stage 5: Lambda whitelist + status constants (15 min, low risk)

Create `lib-aws/appt-statuses.js` exporting the same APPT_STATUSES map (label, isActive, isTerminal). Both frontend and Lambda import from the same conceptual config. Add validation in appointments-upsert.js to reject unknown statuses.

This is the "thin Lambda whitelist" forward-path item we logged earlier. Bundle here because the reschedule work already touches appointment status logic.

## Open Questions (answer before Stage 2)

1. Payment record: link or new? My recommendation: link.
2. Confirmation email on reschedule: send or skip? My recommendation: send with "rescheduled" subject.
3. Group bookings: clone all related rows? My recommendation: yes.
4. Cancellation of a rescheduled appointment: should it also restore the original's status? My recommendation: no, original stays 'rescheduled' forever. Cancellation of the NEW appointment only affects the NEW row.
