import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { authRouter } from "./modules/auth/auth.routes";
import { propertiesRouter } from "./modules/properties/properties.routes";
import { roomsRouter } from "./modules/rooms/rooms.routes";
import { bedsRouter } from "./modules/beds/beds.routes";
import { occupancyRouter } from "./modules/occupancy/occupancy.routes";
import { tenantsRouter } from "./modules/tenants/tenants.routes";
import { staysRouter } from "./modules/stays/stays.routes";
import { billsRouter } from "./modules/bills/bills.routes";
import { paymentsRouter } from "./modules/payments/payments.routes";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes";
import { meRouter } from "./modules/me/me.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { staffRouter } from "./modules/staff/staff.routes";
import { automationRouter } from "./modules/automation/automation.routes";
import { expensesRouter } from "./modules/expenses/expenses.routes";
import { reportsRouter } from "./modules/reports/reports.routes";
import { internalRouter } from "./modules/internal/internal.routes";

// Slows down password guessing: at most 20 login/signup tries per IP every 15 minutes.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many attempts. Please try again in a few minutes." } },
});

// A generous limit for everything else, just to stop abuse.
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many requests. Please slow down." } },
});

export function createApp() {
  const app = express();

  // Render (and most hosts) put a proxy in front of the app. Without this, every user would
  // look like the same IP and the rate limits below would hit everyone at once.
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(",").map((o) => o.trim()),
    })
  );
  app.use(express.json({ limit: "1mb" }));
  if (env.NODE_ENV !== "test") app.use(morgan("dev"));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  app.use("/api/internal", internalRouter);
  app.use("/api", generalLimiter);
  app.use("/api/auth/login", authLimiter);
  app.use("/api/auth/signup", authLimiter);
  app.use("/api/auth", authRouter);
  app.use("/api/properties", propertiesRouter);
  app.use("/api/rooms", roomsRouter);
  app.use("/api/beds", bedsRouter);
  app.use("/api/occupancy", occupancyRouter);
  app.use("/api/tenants", tenantsRouter);
  app.use("/api/stays", staysRouter);
  app.use("/api/bills", billsRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/me", meRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/staff", staffRouter);
  app.use("/api/automation", automationRouter);
  app.use("/api/expenses", expensesRouter);
  app.use("/api/reports", reportsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
