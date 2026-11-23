import { createApp } from "./app";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { startScheduler } from "./lib/scheduler";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`PG Manager API running on http://localhost:${env.PORT}`);
  startScheduler();
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
