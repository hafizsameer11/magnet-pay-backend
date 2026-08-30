export const DEFAULT_ORIGIN_HUBS = [
  { code: "GZ", city: "Guangzhou", hub: "Baiyun · MagnetPay HQ", active: true, sortOrder: 0 },
  { code: "YW", city: "Yiwu", hub: "Futian Market hub", active: true, sortOrder: 1 },
  { code: "SZ", city: "Shenzhen", hub: "Yantian gateway", active: true, sortOrder: 2 },
  { code: "NB", city: "Ningbo", hub: "Beilun port hub", active: true, sortOrder: 3 },
] as const;

export const DEFAULT_PACKAGING_TYPES = [
  { name: "Carton", active: true, sortOrder: 0 },
  { name: "Pallet", active: true, sortOrder: 1 },
  { name: "Crate", active: true, sortOrder: 2 },
  { name: "Drum", active: true, sortOrder: 3 },
  { name: "Bag", active: true, sortOrder: 4 },
] as const;

export const DEFAULT_PRODUCT_ESTIMATE_FOOTNOTE =
  "Customs & clearing added on top by MagnetPay. Final amount locked in escrow.";
