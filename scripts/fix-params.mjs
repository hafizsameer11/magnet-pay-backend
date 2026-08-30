import fs from "fs";
import path from "path";

const root = path.join(process.cwd(), "src/routes");
for (const f of fs.readdirSync(root)) {
  if (!f.endsWith(".ts")) continue;
  const p = path.join(root, f);
  let s = fs.readFileSync(p, "utf8");
  const orig = s;
  s = s.replace(/req\.params\.([a-zA-Z0-9_]+)/g, 'param(req, "$1")');
  if (s === orig) continue;
  if (!/import[^;]*\bparam\b/.test(s)) {
    s = s.replace(
      /import \{([^}]+)\} from "\.\.\/lib\/http\.js";/,
      (_, inner) => {
        if (inner.includes("param")) return `import {${inner}} from "../lib/http.js";`;
        return `import {${inner.trim()}, param } from "../lib/http.js";`;
      },
    );
  }
  fs.writeFileSync(p, s);
  console.log("updated", f);
}
