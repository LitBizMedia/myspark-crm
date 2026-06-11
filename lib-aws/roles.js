// lib/roles.js
// Canonical role-group definitions for subaccount access gating.
//
// One source of truth for "which roles count as which tier." Every backend
// endpoint that gates on role should import a group from here and pass it to
// requireSubaccountAuth(req, res, { requireRole: GROUP }) rather than
// hand-writing role string comparisons. This kills the scattered-string drift
// that previously disabled enforcement silently (see the practitioner cleanup,
// June 2026).
//
// super_admin is the agency login-as identity. It MUST be included in every
// tier at or above admin, or agency impersonation silently loses access to
// gated endpoints. Never write a gate that omits super_admin.
//
// Tiers (ascending privilege is NOT strictly linear — power_user is a sales
// operator, not a mini-manager; some endpoints gate it out deliberately):
//
//   ADMIN_ONLY   - global/system config: settings, payment settings, plan
//                  catalog, edit-admin-users, contact hard-delete.
//   MANAGER_UP   - runs the business: void/refund, hard-deletes, catalog,
//                  automations, forms management, contract templates, gift
//                  card catalog, coupon management, revenue, reporting.
//   POWER_UP     - front-office operations: sell gift cards/packs/subs, send
//                  contracts/forms, view submissions, full contact CRUD
//                  except delete.
//   ANY          - any authenticated subaccount user (POS, apply coupon,
//                  book appointment, add a contact note). For these, use a
//                  plain requireSubaccountAuth with no requireRole at all;
//                  ANY is exported only for explicitness where helpful.

const ADMIN_ONLY = ['admin', 'super_admin'];
const MANAGER_UP = ['admin', 'super_admin', 'manager'];
const POWER_UP   = ['admin', 'super_admin', 'manager', 'power_user'];
const ANY        = ['admin', 'super_admin', 'manager', 'power_user', 'user'];

module.exports = { ADMIN_ONLY, MANAGER_UP, POWER_UP, ANY };
