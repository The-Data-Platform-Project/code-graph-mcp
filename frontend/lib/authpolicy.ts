/**
 * Every sign-in limit in one place. Windows are 15 minutes.
 *
 * | Surface                     | Per IP              | Per account / session                  |
 * |-----------------------------|---------------------|----------------------------------------|
 * | Owner password login        | 5 attempts          | lockout after 10 failures (15 min, doubling) |
 * | GitHub sign-in start        | 10 attempts         | n/a (GitHub authenticates)             |
 * | GitHub sign-in callback     | 10 attempts         | n/a                                    |
 * | 2FA code (sign-in, enrol,   | 10 attempts         | 5 attempts per session; lockout after  |
 * |  disable, new backup codes) |                     | 5 failures (15 min, doubling)          |
 * | MCP bearer token            | lockout at 20 fails | n/a (256-bit tokens)                   |
 *
 * On every surface, each failure after the 3rd adds exponential backoff (2, 4,
 * 8 ... seconds, at most 15 minutes) before lockout. The owner login also asks
 * for a CAPTCHA after 3 failures (lib/captcha.ts says when it cannot).
 */
import type { Window } from "./ratelimit";

const FIFTEEN_MIN = 15 * 60;

export const LOGIN_PER_IP: Window = { limit: 5, windowSec: FIFTEEN_MIN };
export const LOGIN_FAILURES = { windowSec: FIFTEEN_MIN, lockAfter: 10, lockSec: FIFTEEN_MIN };

export const OAUTH_PER_IP: Window = { limit: 10, windowSec: FIFTEEN_MIN };

export const MFA_PER_IP: Window = { limit: 10, windowSec: FIFTEEN_MIN };
export const MFA_PER_SESSION: Window = { limit: 5, windowSec: FIFTEEN_MIN };
export const MFA_FAILURES = { windowSec: FIFTEEN_MIN, lockAfter: 5, lockSec: FIFTEEN_MIN };

export const MCP_BAD_TOKEN_PER_IP = { windowSec: FIFTEEN_MIN, lockAfter: 20, lockSec: FIFTEEN_MIN };
