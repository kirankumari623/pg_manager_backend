// Creates the PLATFORM_ADMIN account (you, the product owner).
// Usage: SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=yourpassword npm run seed
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient, Role } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD before running the seed");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: { passwordHash },
    create: {
      name: "Platform Admin",
      email: email.toLowerCase(),
      passwordHash,
      role: Role.PLATFORM_ADMIN,
      organizationId: null,
    },
  });
  console.log(`Platform admin ready: ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
