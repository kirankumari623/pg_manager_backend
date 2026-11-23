import bcrypt from "bcryptjs";
import { Role, User } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";
import { signToken } from "../../lib/jwt";
import { ChangePasswordInput, LoginInput, SignupInput } from "./auth.schema";

// Never send the password hash back to the client.
function publicUser(user: User) {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

function tokenFor(user: User) {
  return signToken({ userId: user.id, role: user.role, organizationId: user.organizationId });
}

// A new PG owner signs up: creates their Organization and the OWNER user together.
export async function signup(input: SignupInput) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw HttpError.conflict("An account with this email already exists");

  const passwordHash = await bcrypt.hash(input.password, 12);

  const user = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: { name: input.organizationName, email: input.email, phone: input.phone },
    });
    return tx.user.create({
      data: {
        organizationId: organization.id,
        name: input.name,
        email: input.email,
        phone: input.phone,
        passwordHash,
        role: Role.OWNER,
      },
    });
  });

  return { token: tokenFor(user), user: publicUser(user) };
}

export async function login(input: LoginInput) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  // Same message for "no such user" and "wrong password" so emails can't be probed.
  const valid = user ? await bcrypt.compare(input.password, user.passwordHash) : false;
  if (!user || !valid) throw HttpError.unauthorized("Invalid email or password");
  if (!user.isActive) throw HttpError.forbidden("This account has been deactivated");

  return { token: tokenFor(user), user: publicUser(user) };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { organization: true },
  });
  if (!user) throw HttpError.notFound("User not found");
  return { ...publicUser(user), organization: user.organization };
}

export async function changePassword(userId: string, input: ChangePasswordInput) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw HttpError.notFound("User not found");

  const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
  if (!valid) throw HttpError.unauthorized("Current password is incorrect");

  const passwordHash = await bcrypt.hash(input.newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
}
