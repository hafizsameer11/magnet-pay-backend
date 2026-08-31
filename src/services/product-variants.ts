import { z } from "zod";

export type VariantAxis = { name: string; values: string[] };
export type VariantOptions = Record<string, string>;

const emptyToNull = (v: unknown) => (v === "" ? null : v);

export const variantInputSchema = z.object({
  sku: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  options: z.record(z.string(), z.string()),
  priceMinor: z.union([z.string(), z.number()]),
  stock: z.preprocess(emptyToNull, z.number().int().nonnegative().nullable().optional()),
  imageUrl: z.preprocess(emptyToNull, z.string().url().nullable().optional()),
});

export function variantKeyFromOptions(options: VariantOptions): string {
  const keys = Object.keys(options).sort();
  if (!keys.length) return "";
  return keys.map((k) => `${k}:${options[k]}`).join("|");
}

export function variantLabelFromOptions(options: VariantOptions): string {
  const keys = Object.keys(options).sort();
  if (!keys.length) return "";
  return keys.map((k) => `${k}: ${options[k]}`).join(" · ");
}

export function generateCombinations(axes: VariantAxis[]): VariantOptions[] {
  if (!axes.length) return [];
  return axes.reduce<VariantOptions[]>((acc, axis) => {
    const vals = axis.values.map((v) => v.trim()).filter(Boolean);
    if (!vals.length) return acc;
    if (!acc.length) return vals.map((v) => ({ [axis.name]: v }));
    const out: VariantOptions[] = [];
    for (const combo of acc) {
      for (const v of vals) out.push({ ...combo, [axis.name]: v });
    }
    return out;
  }, []);
}

export function optionsMatch(a: VariantOptions, b: VariantOptions): boolean {
  return variantKeyFromOptions(a) === variantKeyFromOptions(b);
}
