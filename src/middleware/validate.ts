import { NextFunction, Request, Response } from "express";
import { ZodTypeAny } from "zod";
import { HttpError } from "../lib/httpError";

// Validates req.body against a Zod schema and replaces it with the parsed
// (typed, trimmed, defaulted) result.
export const validateBody =
  (schema: ZodTypeAny) => (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(HttpError.badRequest("Validation failed", result.error.flatten().fieldErrors));
    }
    req.body = result.data;
    next();
  };
