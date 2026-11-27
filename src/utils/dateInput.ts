import { z } from "zod";

// A real calendar date written as 2026-11-13. Becomes a plain date (midnight UTC), the same
// way bill due dates and expense dates are stored.
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must look like 2026-11-13")
  .refine(
    (v) => !isNaN(new Date(`${v}T00:00:00.000Z`).getTime()) && new Date(`${v}T00:00:00.000Z`).toISOString().startsWith(v),
    "not a real date"
  )
  .transform((v) => new Date(`${v}T00:00:00.000Z`));
