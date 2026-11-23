import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CORS_ORIGIN: z.string().default("*"),

  // Email: "console" prints emails in the terminal (no setup), "smtp" really sends them.
  EMAIL_PROVIDER: z.enum(["console", "smtp"]).default("console"),
  EMAIL_FROM: z.string().default("PG Manager <no-reply@example.com>"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  // The daily automation job. Default: every day at 9:00 AM India time.
  SCHEDULER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.trim().toLowerCase() !== "false"),
  SCHEDULER_CRON: z.string().default("0 9 * * *"),

  // Optional. When set, POST /api/internal/run-daily (header x-cron-secret) triggers the daily job.
  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters").optional(),
}).superRefine((value, ctx) => {
  if (value.NODE_ENV === "production") {
    if (value.JWT_SECRET.length < 32) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["JWT_SECRET"], message: "Use at least 32 characters for JWT_SECRET in production" });
    }
    if (value.CORS_ORIGIN.trim() === "*") {
      console.warn("Warning: CORS_ORIGIN is '*' (any website may call the API). Fine for testing; restrict it later.");
    }
  }
  if (value.EMAIL_PROVIDER === "smtp") {
    for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"] as const) {
      if (!value[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when EMAIL_PROVIDER=smtp` });
      }
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
