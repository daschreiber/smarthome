import type { Role } from "./users";

/**
 * Role capabilities, in one place so routes and UI agree:
 * - admin:  everything, plus user management.
 * - member: control + programming (scenes, automations, assistant).
 * - guest:  the skeletal tier — control devices, apply scenes, favorites,
 *           immediate assistant actions. Nothing programmable.
 */

/** Create/delete scenes and automations, program via the assistant. */
export function canProgram(role: Role): boolean {
  return role === "admin" || role === "member";
}

/** Add/remove users, change roles, issue reset links. */
export function canManageUsers(role: Role): boolean {
  return role === "admin";
}
