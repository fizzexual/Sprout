import { z } from "zod";

export type FormState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  id?: string;
};

/** Collect the first error message per field from a ZodError. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in out)) out[key] = issue.message;
  }
  return out;
}

export const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Parse an <input> currency/number string to a non-negative float. */
export function toNumber(value: FormDataEntryValue | null): number {
  if (typeof value !== "string") return 0;
  const n = parseFloat(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Normalize an optional text field: empty string -> null. */
export function optionalText(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.length ? v : null;
}

/** Parse an optional date input (yyyy-mm-dd) to a Date or null. */
export function optionalDate(value: FormDataEntryValue | null): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
