import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { isZodValidationError, validate } from "../middleware/validate.js";

function makeReq(body: unknown): Request {
  return { body } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

// A ZodError thrown by a different zod copy than the one this package
// imports, as happens in the packaged runtime where @paperclipai/shared
// bundles its own zod.
function makeForeignZodError(): Error {
  const err = new Error("validation failed");
  err.name = "ZodError";
  (err as unknown as { issues: unknown[] }).issues = [
    { code: "invalid_type", path: ["payload", "prompt"], message: "Required" },
  ];
  return err;
}

describe("validate", () => {
  const schema = z.object({ name: z.string() });

  it("assigns the parsed body and calls next on valid input", () => {
    const req = makeReq({ name: "ok", extra: "stripped" });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    validate(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ name: "ok" });
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 400 with the issue list on invalid input", () => {
    const req = makeReq({ name: 42 });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    validate(schema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Validation error",
      details: expect.arrayContaining([
        expect.objectContaining({ path: ["name"] }),
      ]),
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 400 when the schema throws a ZodError from another zod copy", () => {
    const foreign = makeForeignZodError();
    const schemaFromOtherCopy = {
      parse: () => {
        throw foreign;
      },
    } as unknown as z.ZodSchema;
    const req = makeReq({});
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    validate(schemaFromOtherCopy)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Validation error",
      details: (foreign as unknown as { issues: unknown[] }).issues,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("forwards non-Zod errors to next", () => {
    const boom = new Error("db exploded");
    const throwingSchema = {
      parse: () => {
        throw boom;
      },
    } as unknown as z.ZodSchema;
    const req = makeReq({});
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    validate(throwingSchema)(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("isZodValidationError", () => {
  it("accepts a real ZodError", () => {
    const result = z.object({ a: z.string() }).safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(isZodValidationError(result.error)).toBe(true);
    }
  });

  it("accepts a structurally-matching error from another zod copy", () => {
    expect(isZodValidationError(makeForeignZodError())).toBe(true);
  });

  it("rejects plain errors and non-errors", () => {
    expect(isZodValidationError(new Error("ZodError"))).toBe(false);
    const named = new Error("x");
    named.name = "ZodError";
    expect(isZodValidationError(named)).toBe(false);
    expect(isZodValidationError({ name: "ZodError", issues: [] })).toBe(false);
    expect(isZodValidationError(null)).toBe(false);
  });
});
