import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: [
    "playwright",
    "playwright-core",
    "@playwright/test",
    "tesseract.js",
    "three",
    "pdf2json",
    "mammoth",
    "xlsx",
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cdn.discordapp.com",
      },
    ],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Externalize playwright and its dependencies from bundling
      config.externals = config.externals || [];
      config.externals.push({
        'playwright': 'commonjs playwright',
        'playwright-core': 'commonjs playwright-core',
      });
    }

    // Ignore problematic file types from ragforge-core
    config.module.rules.push({
      test: /\.(html|ttf|woff|woff2|eot)$/,
      include: /packages\/ragforge-core\/node_modules/,
      use: 'null-loader',
    });

    return config;
  },
};

export default nextConfig;
