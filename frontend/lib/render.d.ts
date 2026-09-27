export function esc(s: unknown): string;
export function renderMarkdown(src: string): string;
export function highlightLines(code: string, family: string): string[];
export function codeBlock(
  text: string,
  lang: string,
  startLine: number,
  hlFrom: number,
  hlTo: number,
): string;
export function langOf(filePath: string): string;
