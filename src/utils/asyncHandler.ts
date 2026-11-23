import { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 doesn't catch errors from async handlers on its own.
// Wrapping a handler with this forwards any thrown error to the error middleware.
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
