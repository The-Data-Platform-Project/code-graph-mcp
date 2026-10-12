// Markdown files are imported as strings (webpack asset/source, next.config.mjs).
declare module "*.md" {
  const content: string;
  export default content;
}

// Word lists (lib/data/*.txt), imported the same way.
declare module "*.txt" {
  const content: string;
  export default content;
}
