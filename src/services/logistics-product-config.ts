import { z } from "zod";
import { getLogisticsEstimateConfig, listActiveParcelTypes } from "./freight-pricing.js";
import { DEFAULT_ORIGIN_HUBS, DEFAULT_PACKAGING_TYPES, DEFAULT_PRODUCT_ESTIMATE_FOOTNOTE } from "./logistics-defaults.js";

export const originHubSchema = z.object({
  code: z.string().min(1).max(8),
  city: z.string().min(1),
  hub: z.string().min(1),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export const packagingTypeSchema = z.object({
  name: z.string().min(1),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export type OriginHubRow = z.infer<typeof originHubSchema>;
export type PackagingTypeRow = z.infer<typeof packagingTypeSchema>;

function parseJsonArray<T>(raw: unknown, schema: z.ZodType<T>, fallback: T[]): T[] {
  if (!Array.isArray(raw)) return fallback;
  const out: T[] = [];
  for (const item of raw) {
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out.length ? out : fallback;
}

function normalizeHub(row: z.input<typeof originHubSchema>): OriginHubRow {
  return {
    code: row.code,
    city: row.city,
    hub: row.hub,
    active: row.active ?? true,
    sortOrder: row.sortOrder ?? 0,
  };
}

function normalizePackaging(row: z.input<typeof packagingTypeSchema>): PackagingTypeRow {
  return {
    name: row.name,
    active: row.active ?? true,
    sortOrder: row.sortOrder ?? 0,
  };
}

export async function getOriginHubs(): Promise<OriginHubRow[]> {
  const config = await getLogisticsEstimateConfig();
  return parseJsonArray(config.originHubs, originHubSchema, DEFAULT_ORIGIN_HUBS.map(normalizeHub))
    .map(normalizeHub)
    .filter((h) => h.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.city.localeCompare(b.city));
}

export async function getPackagingTypes(): Promise<PackagingTypeRow[]> {
  const config = await getLogisticsEstimateConfig();
  return parseJsonArray(config.packagingTypes, packagingTypeSchema, DEFAULT_PACKAGING_TYPES.map(normalizePackaging))
    .map(normalizePackaging)
    .filter((p) => p.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export async function getLogisticsProductWizardConfig() {
  const [config, originHubs, packagingTypes, parcelTypes] = await Promise.all([
    getLogisticsEstimateConfig(),
    getOriginHubs(),
    getPackagingTypes(),
    listActiveParcelTypes(),
  ]);

  return {
    originHubs,
    packagingTypes,
    parcelTypes,
    estimate: {
      modeLabel: config.productEstimateModeLabel ?? "sea LCL",
      cnyPerCbm: config.productSeaLclCnyPerCbm ?? 320,
      defaultDestination: config.productDefaultDestination ?? "Apapa, Lagos",
      transitLabel: config.productSeaTransitLabel ?? "26–32 days",
      currency: "CNY" as const,
      footnote:
        config.productEstimateFootnote ??
        DEFAULT_PRODUCT_ESTIMATE_FOOTNOTE,
      disclaimer: config.estimateDisclaimer,
    },
  };
}

export async function previewProductShippingEstimate(input: {
  cbmPerUnit: number;
  weightKgPerUnit?: number;
  originCity: string;
  parcelTypeId?: string;
}) {
  const wizard = await getLogisticsProductWizardConfig();
  const hub =
    wizard.originHubs.find((h) => h.city === input.originCity) ??
    wizard.originHubs.find((h) => h.code === input.originCity) ??
    wizard.originHubs[0];

  const cnyPerUnit = Math.round(Math.max(0, input.cbmPerUnit) * wizard.estimate.cnyPerCbm);
  const routeLabel = `${hub?.hub ?? input.originCity} → ${wizard.estimate.defaultDestination}`;

  let weightHintMinor: string | undefined;
  let weightFormula: string | undefined;
  if (input.parcelTypeId && input.weightKgPerUnit != null && input.weightKgPerUnit > 0) {
    const pt = wizard.parcelTypes.find((p) => p.id === input.parcelTypeId);
    if (pt) {
      const weightCharge = Math.ceil(input.weightKgPerUnit * pt.ratePerKgMinor);
      const totalMinor = pt.baseMinor + weightCharge;
      weightHintMinor = String(totalMinor);
      weightFormula = `${pt.name}: base ₦${(pt.baseMinor / 100).toLocaleString()} + ${input.weightKgPerUnit}kg × ₦${(pt.ratePerKgMinor / 100).toLocaleString()}/kg`;
    }
  }

  return {
    perUnitCny: cnyPerUnit,
    perUnitCnyDisplay: `≈ ¥${cnyPerUnit.toLocaleString()}`,
    modeLabel: wizard.estimate.modeLabel,
    cnyPerCbm: wizard.estimate.cnyPerCbm,
    routeLabel,
    transitLabel: wizard.estimate.transitLabel,
    footnote: wizard.estimate.footnote,
    disclaimer: wizard.estimate.disclaimer,
    originHub: hub,
    weightHintMinor,
    weightFormula,
    formula: `¥${wizard.estimate.cnyPerCbm}/CBM × ${input.cbmPerUnit} CBM`,
  };
}
