import { z } from "zod";

export const signupSchema = z.object({
  organizationName: z.string().trim().min(2, "PG / business name is required"),
  name: z.string().trim().min(2, "Your name is required"),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().min(10).max(15).optional(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
