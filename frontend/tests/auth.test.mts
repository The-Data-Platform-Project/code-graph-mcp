// Unit tests for the pure auth pieces: TOTP (RFC 6238 vectors) and the
// password policy.   npm test  (node --test, no build needed)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluatePassword } from "../lib/password-policy.ts";
import { DEFAULT_TARGET, safeTarget } from "../lib/redirect.ts";
import { base32Decode, base32Encode, hotp, matchTotp, otpauthUri } from "../lib/totp.ts";

// RFC 6238 Appendix B, SHA-1 key "12345678901234567890"; we use 6 digits, so
// the expected values are the last 6 digits of the RFC's 8-digit codes.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));
const VECTORS: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
];

test("base32 round-trips and matches the RFC key", () => {
  assert.equal(RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(base32Decode(RFC_SECRET).toString("ascii"), "12345678901234567890");
  assert.throws(() => base32Decode("not-base32!"));
});

test("TOTP matches the RFC 6238 test vectors", () => {
  const key = base32Decode(RFC_SECRET);
  for (const [t, code] of VECTORS) assert.equal(hotp(key, Math.floor(t / 30)), code, `T=${t}`);
});

test("matchTotp accepts ±1 step and refuses others", () => {
  const now = 1234567890 * 1000;
  assert.equal(matchTotp(RFC_SECRET, "005924", { nowMs: now }), Math.floor(1234567890 / 30));
  assert.notEqual(matchTotp(RFC_SECRET, "005924", { nowMs: now + 30_000 }), null);
  assert.equal(matchTotp(RFC_SECRET, "005924", { nowMs: now + 90_000 }), null);
  assert.equal(matchTotp(RFC_SECRET, "000000", { nowMs: now }), null);
  assert.equal(matchTotp(RFC_SECRET, "abc123", { nowMs: now }), null);
});

test("otpauth URI names the issuer and parameters", () => {
  const uri = otpauthUri(RFC_SECRET, "octocat");
  assert.match(uri, /^otpauth:\/\/totp\/ContextForge%3Aoctocat\?/);
  assert.match(uri, /secret=GEZDGNBV/);
  assert.match(uri, /digits=6/);
});

const common = new Set(
  readFileSync(new URL("../lib/data/common-passwords-10k.txt", import.meta.url), "utf8")
    .split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean),
);

test("the common list holds the top 10,000", () => {
  assert.ok(common.size >= 9_900);
  for (const pw of ["password", "123456", "12345678", "qwerty"]) assert.ok(common.has(pw), pw);
});

test("weak passwords are refused", () => {
  for (const pw of ["password123", "12345678", "Password123!", "Summer2024!!", "Qwerty123456!", "aaaaaaaaaaaA1!"]) {
    assert.equal(evaluatePassword(pw, common).ok, false, pw);
  }
});

test("each rule reports its own problem", () => {
  const short = evaluatePassword("Ab1!xyz", common);
  assert.ok(short.problems.some((p) => p.includes("12 characters")));
  assert.ok(evaluatePassword("alllowercase-words-here-9", common).problems.some((p) => p.includes("upper-case")));
  assert.ok(evaluatePassword("ALLUPPER-WORDS-HERE-9", common).problems.some((p) => p.includes("lower-case")));
  assert.ok(evaluatePassword("No-Digits-In-Here-Ever", common).problems.some((p) => p.includes("digit")));
  assert.ok(evaluatePassword("NoSymbols1nHereEverReally", common).problems.some((p) => p.includes("symbol")));
});

test("a long, unpredictable password passes", () => {
  const v = evaluatePassword("Tr0ub4dor&3-Gl4cier!River", common);
  assert.equal(v.ok, true, v.problems.join(" "));
  assert.ok(v.score >= 3);
});

test("safeTarget keeps same-origin paths and refuses everything else", () => {
  assert.equal(safeTarget("/settings?x=1#security"), "/settings?x=1#security");
  assert.equal(safeTarget("/login/verify?next=%2Fgraph"), "/login/verify?next=%2Fgraph");
  for (const bad of [
    "//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/ /evil.example",
    "https://evil.example", "javascript:alert(1)", "", null, undefined, "/\u0000x",
  ]) {
    assert.equal(safeTarget(bad), DEFAULT_TARGET, JSON.stringify(bad));
  }
});
