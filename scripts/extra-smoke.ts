/** Extra money/KYC smoke. Run: npx tsx scripts/extra-smoke.ts */
const BASE = process.env.API_URL ?? "http://127.0.0.1:4000";

async function login(phone: string) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, passcode: "123456" }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.data.accessToken as string;
}

async function call(token: string, path: string, body?: unknown, method = "POST") {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  return { ok: r.ok, status: r.status, message: j.error?.message ?? "ok" };
}

async function main() {
  const t = await login("+2348123456789");
  const checks: [string, { ok: boolean; status: number; message: string }][] = [];
  checks.push(["deposit", await call(t, "/wallets/deposit", { currency: "NGN", amountMinor: "50000", method: "virtual" })]);
  checks.push(["fx convert", await call(t, "/wallets/fx/convert", { from: "NGN", to: "CNY", amountMinor: "100000" })]);
  checks.push(["withdraw", await call(t, "/wallets/withdraw", { currency: "CNY", amountMinor: "1000", rail: "BANK", destination: "ICBC test" })]);
  checks.push(["kyc", await call(t, "/me/kyc", { type: "BVN", payload: { bvn: "12345678901" } })]);
  checks.push(["address", await call(t, "/me/addresses", { label: "Home", line1: "12 Marina", city: "Lagos", country: "NG" })]);
  checks.push(["bank", await call(t, "/me/bank-accounts", { bankName: "GTBank", accountName: "Chidi", accountNo: "0123456789", currency: "NGN", country: "NG" })]);
  let failed = 0;
  for (const [name, r] of checks) {
    console.log(`${r.ok ? "✓" : "✗"} ${name} — ${r.status} ${r.message}`);
    if (!r.ok) failed++;
  }
  if (failed) process.exit(1);
  console.log("\nExtra money/KYC features OK.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
