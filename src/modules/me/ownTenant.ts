import { prisma } from "../../lib/prisma";
import { HttpError } from "../../lib/httpError";

// Finds the tenant profile linked to the logged-in account (used by every /api/me endpoint).
export async function ownTenant(userId: string, organizationId: string) {
  const tenant = await prisma.tenant.findFirst({
    where: { userId, organizationId },
    include: { organization: { select: { name: true, phone: true, email: true } } },
  });
  if (!tenant) throw HttpError.notFound("No tenant profile is linked to this account");
  return tenant;
}
