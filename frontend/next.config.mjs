/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output keeps the runtime image small: the compose `app`
  // service copies only .next/standalone rather than all of node_modules.
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  webpack(config) {
    // Docs and the admin guide are Markdown under content/, imported as
    // strings. They are bundled with whatever imports them — server code
    // only — so there is no runtime file read to trace or to get wrong.
    config.module.rules.push({ test: /\.md$/, type: "asset/source" });
    return config;
  },
};

export default nextConfig;
