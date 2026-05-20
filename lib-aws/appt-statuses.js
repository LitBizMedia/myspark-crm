// Appointment status registry. MUST be kept in sync with the frontend
// APPT_STATUSES map in index.html. Adding a new status means updating BOTH
// files. See "Common Mistakes to Avoid" in MySpark-Project-Instructions.md.
//
// isActive=true: slot is occupied (blocks new bookings, counts toward
//   "today's appointments", appears on calendar normally)
// isActive=false: slot is released (cancelled, completed, no-show, rescheduled)

const APPT_STATUSES = {
  scheduled:    { label: 'Scheduled',    isActive: true  },
  waiting_room: { label: 'Waiting Room', isActive: true  },
  completed:    { label: 'Completed',    isActive: false },
  rescheduled:  { label: 'Rescheduled',  isActive: false },
  'no-show':    { label: 'No-show',      isActive: false },
  cancelled:    { label: 'Cancelled',    isActive: false }
};

const VALID_STATUSES = Object.keys(APPT_STATUSES);
const TERMINAL_STATUSES = VALID_STATUSES.filter(s => !APPT_STATUSES[s].isActive);
const ACTIVE_STATUSES = VALID_STATUSES.filter(s => APPT_STATUSES[s].isActive);

function isValidStatus(status) {
  return VALID_STATUSES.indexOf(status) !== -1;
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.indexOf(status) !== -1;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.indexOf(status) !== -1;
}

// SQL fragment helpers for conflict checks. Returns the inverse list as a
// SQL-safe IN clause string. Used by checkStaffConflict callers.
function buildTerminalNotInClause() {
  const list = TERMINAL_STATUSES.map(s => "'" + s + "'").join(',');
  return "status NOT IN (" + list + ")";
}

module.exports = {
  APPT_STATUSES,
  VALID_STATUSES,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  isValidStatus,
  isActiveStatus,
  isTerminalStatus,
  buildTerminalNotInClause
};
