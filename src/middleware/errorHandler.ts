import { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { HttpError } from "../lib/httpError";
import { env } from "../config/env";

export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(HttpError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

// Every error ends up here and is returned as { error: { message, details? } }.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { message: err.message, details: err.details } });
  }

  // Unique constraint violation (e.g. duplicate email)
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    return res.status(409).json({ error: { message: "A record with these details already exists" } });
  }

  console.error(err);
  res.status(500).json({
    error: {
      message: "Something went wrong on the server",
      ...(env.NODE_ENV === "development" && err instanceof Error ? { details: err.message } : {}),
    },
  });
}
