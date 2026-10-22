/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@noctella/shared"],
  // S1-a: disable the /_next/image optimizer endpoint while Next stays 14.2.35 (image optimizer advisories).
  images: { unoptimized: true },
};

module.exports = nextConfig;
