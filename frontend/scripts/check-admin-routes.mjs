#!/usr/bin/env node
// CI guard: every route under app/api/admin/ must wrap its handlers in
// withAdmin (lib/handler.ts), which enforces platform admin + 2FA on the
// server. Fails the build if a new admin route forgets.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../app/api/admin/", import.meta.url).pathname;
const bad = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name === "route.ts") {
      const src = readFileSync(path, "utf8");
      const handlers = [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*([A-Za-z]+)\(/g)];
      const exportedFns = /export (async )?function (GET|POST|PUT|PATCH|DELETE)/.test(src);
      if (exportedFns || handlers.length === 0 || handlers.some((m) => m[2] !== "withAdmin")) bad.push(path);
    }
  }
}
walk(root);
if (bad.length) {
  console.error("Admin routes not wrapped in withAdmin:\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log("admin routes: all wrapped in withAdmin");
