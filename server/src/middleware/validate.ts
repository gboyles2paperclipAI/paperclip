import type { Request, Response, NextFunction } from "express";
import type { ZodIssue, ZodSchema } from "zod";
import { ZodError } from "zod";

// The packaged runtime ships multiple zod copies (@paperclipai/shared and
// @paperclipai/server each bundle their own), so a ZodError thrown by a shared
// schema fails `instanceof ZodError` against this package's class and would
// fall through to the generic 500 handler. Detect validation failures
// structurally as well as by instance.
export function isZodValidationError(
  err: unknown,
): err is Error & { issues: ZodIssue[] } {
  if (err instanceof ZodError) return true;
  return (
    err instanceof Error &&
    err.name === "ZodError" &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    let parsed: unknown;
    try {
      parsed = schema.parse(req.body);
    } catch (err) {
      if (isZodValidationError(err)) {
        res.status(400).json({ error: "Validation error", details: err.issues });
        return;
      }
      next(err);
      return;
    }
    req.body = parsed;
    next();
  };
}
