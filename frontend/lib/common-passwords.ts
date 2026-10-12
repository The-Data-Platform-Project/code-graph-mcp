/**
 * The 10,000 most common passwords (SecLists, MIT licence), bundled with the
 * server code so the check never needs the network.
 */
import "server-only";
import list from "./data/common-passwords-10k.txt";

export const COMMON_PASSWORDS: Set<string> = new Set(
  list.split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean),
);
