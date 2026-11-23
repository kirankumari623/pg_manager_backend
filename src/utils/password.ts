import { randomBytes } from "crypto";

// A random password (11 characters) the owner can hand to a new tenant or staff member.
// It is shown once, and the person should change it after logging in.
export function makeTemporaryPassword() {
  return randomBytes(8).toString("base64url");
}
