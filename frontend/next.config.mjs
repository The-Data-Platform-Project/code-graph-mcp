/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output keeps the runtime image small: the compose `app`
  // service copies only .next/standalone rather than all of node_modules.
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  // Sent with every response. No page is meant to be framed (clickjacking on
  // the sign-in and settings pages), sniffed, or to leak full URLs onward.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://github.com" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  webpack(config) {
    // Docs and the admin guide are Markdown under content/ (and the common-
    // password list is text under lib/data/), imported as
    // strings. They are bundled with whatever imports them — server code
    // only — so there is no runtime file read to trace or to get wrong.
    config.module.rules.push({ test: /\.(md|txt)$/, type: "asset/source" });
    return config;
  },
};

export default nextConfig;
