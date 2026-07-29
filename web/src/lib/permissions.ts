import type { Role } from "./users";

/**
 * Role capabilities, in one place so routes and UI agree:
 * - admin:  everything, plus user management and the activity log.
 * - member: control + programming (scenes, automations, assistant), but may
 *           only delete what they created themselves.
 * - guest:  the skeletal tier — control devices, apply scenes, favorites,
 *           immediate assistant actions. Nothing programmable.
 */

/** Create scenes and automations, program via the assistant. */
export function canProgram(role: Role): boolean {
  return role === "admin" || role === "member";
}

/** Add/remove users, change roles, issue reset links. */
export function canManageUsers(role: Role): boolean {
  return role === "admin";
}

/** See the audit trail — who did what, house-wide. */
export function canViewActivity(role: Role): boolean {
  return role === "admin";
}

/**
 * Operate door locks — the security tier (IMPLEMENTATION_SPEC Phase F).
 * Guests are excluded outright; on top of this, every lock command confirms
 * and unlocking re-verifies the caller's account password in the route.
 */
export function canOperateLocks(role: Role): boolean {
  return role === "admin" || role === "member";
}

/**
 * Delete a scene/automation/timer: admins anything, everyone else only what
 * they created. Records from before user accounts (createdBy "dev" or
 * "app-key") therefore count as admin-owned.
 */
export function canDeleteRecord(role: Role, user: string, createdBy: string): boolean {
  return role === "admin" || user === createdBy;
}
