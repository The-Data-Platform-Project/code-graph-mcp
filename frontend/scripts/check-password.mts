/**
 * Choose OWNER_PASSWORD with live feedback: a strength meter that updates on
 * every keystroke, the same verdict the server enforces (lib/password-policy.ts:
 * 12+ characters, upper/lower/digit/symbol, not in the top 10,000, zxcvbn ≥ 3),
 * and a Have I Been Pwned check when you press Enter.
 *
 *   node --experimental-strip-types scripts/check-password.mts
 *
 * Nothing is stored or sent anywhere except the first 5 hex characters of the
 * password's SHA-1, to Have I Been Pwned's k-anonymity API.
 */
import { readFileSync } from "node:fs";
import { evaluatePassword, MIN_SCORE, pwnedCount } from "../lib/password-policy.ts";

const common = new Set(
  readFileSync(new URL("../lib/data/common-passwords-10k.txt", import.meta.url), "utf8")
    .split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean),
);
const LABELS = ["very weak", "weak", "fair", "strong", "very strong"];

function render(pw: string): void {
  const v = evaluatePassword(pw, common, ["owner", "contextforge", "codegraph", "admin"]);
  const bar = "█".repeat(v.score + 1).padEnd(5, "░");
  const first = v.problems[0] ?? (v.ok ? "Meets the policy. Press Enter to check breaches." : "");
  process.stdout.write(`\r\x1b[2K  ${bar} ${LABELS[v.score].padEnd(11)} ${"*".repeat(Math.min(pw.length, 40))}  ${first}`);
}

async function main(): Promise<number> {
  if (!process.stdin.isTTY) {
    const pw = readFileSync(0, "utf8").replace(/\r?\n$/, "");
    return report(pw);
  }
  console.log(`  Type a candidate password (min zxcvbn score ${MIN_SCORE}). Enter to finish, Ctrl-C to quit.\n`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let pw = "";
  render(pw);
  return new Promise((resolve) => {
    process.stdin.on("data", async (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n\n");
          resolve(await report(pw));
          return;
        }
        if (ch === "\u007f" || ch === "\b") pw = pw.slice(0, -1);
        else if (ch >= " ") pw += ch;
      }
      render(pw);
    });
  });
}

async function report(pw: string): Promise<number> {
  const v = evaluatePassword(pw, common, ["owner", "contextforge", "codegraph", "admin"]);
  console.log(`  Strength: ${LABELS[v.score]} (zxcvbn ${v.score}/4)`);
  for (const p of v.problems) console.log(`  ✗ ${p}`);
  for (const s of v.suggestions) console.log(`  · ${s}`);
  const seen = await pwnedCount(pw);
  if (seen === null) console.log("  ? Have I Been Pwned could not be reached; the server checks again at first login.");
  else if (seen > 0) console.log(`  ✗ Seen ${seen} times in known data breaches.`);
  else console.log("  ✓ Not found in known data breaches.");
  const ok = v.ok && !(seen && seen > 0);
  console.log(ok ? "\n  OK: the server will accept this as OWNER_PASSWORD." : "\n  Refused: the server will not accept this.");
  return ok ? 0 : 1;
}

process.exit(await main());
