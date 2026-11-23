import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { authenticate } from "../../middleware/auth";
import { changePasswordSchema, loginSchema, signupSchema } from "./auth.schema";
import * as authService from "./auth.service";

export const authRouter = Router();

// POST /api/auth/signup  -> create a new PG owner account + organization
authRouter.post(
  "/signup",
  validateBody(signupSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.signup(req.body);
    res.status(201).json(result);
  })
);

// POST /api/auth/login
authRouter.post(
  "/login",
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body);
    res.json(result);
  })
);

// GET /api/auth/me  -> who am I? (needs token)
authRouter.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const me = await authService.getMe(req.auth!.userId);
    res.json({ user: me });
  })
);

// POST /api/auth/change-password  -> any logged-in user changes their own password
authRouter.post(
  "/change-password",
  authenticate,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    await authService.changePassword(req.auth!.userId, req.body);
    res.json({ message: "Password changed" });
  })
);
