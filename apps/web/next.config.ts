import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@christopher/db", "@christopher/core"],
  serverExternalPackages: ["pg"],
};

export default nextConfig;
