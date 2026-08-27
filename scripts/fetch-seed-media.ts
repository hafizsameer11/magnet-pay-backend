/**
 * Download seed catalog images into seed-media/ for Git + offline server seeding.
 * Run: npm run seed:media
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../seed-media");

const ASSETS: Record<string, string> = {
  "avatar-buyer.jpg": "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=400&q=80&auto=format&fit=crop",
  "avatar-seller.jpg": "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&q=80&auto=format&fit=crop",
  "avatar-amaka.jpg": "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400&q=80&auto=format&fit=crop",
  "avatar-kwame.jpg": "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&q=80&auto=format&fit=crop",
  "avatar-seller2.jpg": "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400&q=80&auto=format&fit=crop",
  "pump.jpg": "https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=800&q=70&auto=format&fit=crop",
  "pump2.jpg": "https://images.unsplash.com/photo-1581092160562-40aa08e78837?w=800&q=70&auto=format&fit=crop",
  "pump3.jpg": "https://images.unsplash.com/photo-1581092160562-40aa08e78837?w=800&q=70&auto=format&fit=crop",
  "pump4.jpg": "https://images.unsplash.com/photo-1581092918056-0c4c3acd3789?w=800&q=70&auto=format&fit=crop",
  "textile.jpg": "https://images.unsplash.com/photo-1558171813-4c088753af8f?w=800&q=70&auto=format&fit=crop",
  "solar.jpg": "https://images.unsplash.com/photo-1509391366360-2e959784a276?w=800&q=70&auto=format&fit=crop",
  "electronics.jpg": "https://images.unsplash.com/photo-1498049794561-7780e7231661?w=800&q=70&auto=format&fit=crop",
  "machinery.jpg": "https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?w=800&q=70&auto=format&fit=crop",
  "shipping.jpg": "https://images.unsplash.com/photo-1494412519320-aa613dfb7738?w=800&q=70&auto=format&fit=crop",
  "led.jpg": "https://images.unsplash.com/photo-1498049794561-7780e7231661?w=800&q=70&auto=format&fit=crop",
  "bags.jpg": "https://images.unsplash.com/photo-1558171813-4c088753af8f?w=800&q=70&auto=format&fit=crop",
  "tiles.jpg": "https://images.unsplash.com/photo-1615876234686-2a2a3a775a3a?w=800&q=70&auto=format&fit=crop",
  "fittings.jpg": "https://images.unsplash.com/photo-1504328345606-18bbc8c9d7d1?w=800&q=70&auto=format&fit=crop",
  "mailers.jpg": "https://images.unsplash.com/photo-1586075010923-2dd4570fb338?w=800&q=70&auto=format&fit=crop",
  "charger.jpg": "https://images.unsplash.com/photo-1593941707882-a5bba14938ca?w=800&q=70&auto=format&fit=crop",
  "beauty.jpg": "https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=800&q=70&auto=format&fit=crop",
  "boxes.jpg": "https://images.unsplash.com/photo-1586075010923-2dd4570fb338?w=800&q=70&auto=format&fit=crop",
};

async function download(name: string, url: string) {
  const dest = path.join(ROOT, name);
  if (fs.existsSync(dest)) {
    console.log("skip", name);
    return;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log("saved", name);
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  let failed = 0;
  for (const [name, url] of Object.entries(ASSETS)) {
    try {
      await download(name, url);
    } catch (e) {
      failed++;
      console.error("fail", name, e instanceof Error ? e.message : e);
    }
  }
  if (failed) {
    console.warn(`${failed} asset(s) failed — re-run or add files manually to seed-media/`);
  }
  console.log("Done — commit magnetpay-api/seed-media/ to Git.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
