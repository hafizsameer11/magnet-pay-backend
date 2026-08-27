export type HsCodeRow = {
  code: string;
  description: string;
  category: string;
  dutyPctNG: number;
  dutyPctGH: number;
  dutyPctKE: number;
  vatPct: number;
  restrictedIn: string[];
  requiresCert: string[];
};

export const HS_CODES: HsCodeRow[] = [
  {
    code: "8413.70",
    description: "Centrifugal pumps",
    category: "Machinery",
    dutyPctNG: 5,
    dutyPctGH: 10,
    dutyPctKE: 10,
    vatPct: 7.5,
    restrictedIn: [],
    requiresCert: [],
  },
  {
    code: "8413.91",
    description: "Parts of pumps — bodies, impellers",
    category: "Machinery",
    dutyPctNG: 5,
    dutyPctGH: 10,
    dutyPctKE: 10,
    vatPct: 7.5,
    restrictedIn: [],
    requiresCert: [],
  },
  {
    code: "8504.40",
    description: "Static converters / power adapters",
    category: "Electronics",
    dutyPctNG: 10,
    dutyPctGH: 12.5,
    dutyPctKE: 10,
    vatPct: 7.5,
    restrictedIn: [],
    requiresCert: ["SONCAP (NG)", "GS (GH)"],
  },
  {
    code: "8517.62",
    description: "Telecom apparatus (modems, routers)",
    category: "Telecom",
    dutyPctNG: 20,
    dutyPctGH: 20,
    dutyPctKE: 25,
    vatPct: 7.5,
    restrictedIn: [],
    requiresCert: ["NCC type-approval (NG)"],
  },
  {
    code: "5208.42",
    description: "Cotton fabrics, woven, dyed",
    category: "Textiles",
    dutyPctNG: 35,
    dutyPctGH: 20,
    dutyPctKE: 25,
    vatPct: 7.5,
    restrictedIn: ["NG (seasonal import ban)"],
    requiresCert: [],
  },
  {
    code: "7323.99",
    description: "Cookware, iron/steel, household",
    category: "Kitchenware",
    dutyPctNG: 20,
    dutyPctGH: 20,
    dutyPctKE: 25,
    vatPct: 7.5,
    restrictedIn: [],
    requiresCert: ["SON (NG)"],
  },
  {
    code: "9403.20",
    description: "Metal furniture (other than office)",
    category: "Furniture",
    dutyPctNG: 20,
    dutyPctGH: 20,
    dutyPctKE: 25,
    vatPct: 7.5,
    restrictedIn: [],
    requiresCert: [],
  },
  {
    code: "6703.00",
    description: "Human hair, processed/prepared",
    category: "Beauty",
    dutyPctNG: 20,
    dutyPctGH: 20,
    dutyPctKE: 25,
    vatPct: 7.5,
    restrictedIn: [],
    requiresCert: ["NAFDAC (NG)"],
  },
];

export function searchHsCodes(q: string, limit = 20): HsCodeRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return HS_CODES.slice(0, limit);
  return HS_CODES.filter(
    (h) =>
      h.code.includes(needle) ||
      h.description.toLowerCase().includes(needle) ||
      h.category.toLowerCase().includes(needle),
  ).slice(0, limit);
}

export function getHsCode(code: string): HsCodeRow | undefined {
  const norm = code.trim();
  return HS_CODES.find((h) => h.code === norm || h.code.replace(/\./g, "") === norm.replace(/\./g, ""));
}

export function dutyPctForDestination(row: HsCodeRow, destination: string): number {
  const d = destination.toUpperCase();
  if (d.includes("GH") || d.includes("GHANA")) return row.dutyPctGH;
  if (d.includes("KE") || d.includes("KENYA")) return row.dutyPctKE;
  return row.dutyPctNG;
}
