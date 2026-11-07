import type { z } from "zod";

export function validatedHandler<I, O>(input: z.ZodType<I>, output: z.ZodType<O>, handler: (value: I) => Promise<O> | O) {
  return async (value: unknown): Promise<O> => output.parse(await handler(input.parse(value)));
}
