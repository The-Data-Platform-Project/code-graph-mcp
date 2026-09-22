/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output keeps the runtime image small: the compose `app`
  // service copies only .next/standalone rather than all of node_modules.
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
