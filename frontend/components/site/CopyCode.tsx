"use client";

import { useEffect } from "react";

/**
 * One listener for every code block's Copy button. The buttons are rendered
 * on the server as plain HTML (lib/markdown.ts), so this is the only script
 * the docs need.
 */
export default function CopyCode() {
  useEffect(() => {
    const onClick = async (e: MouseEvent) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-copy]");
      if (!btn) return;
      const code = btn.closest(".code")?.querySelector("pre")?.innerText ?? "";
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = "Copied";
        btn.setAttribute("data-copied", "");
      } catch {
        btn.textContent = "Select and copy";
      }
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.removeAttribute("data-copied");
      }, 1600);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}
