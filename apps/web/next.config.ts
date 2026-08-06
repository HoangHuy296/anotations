import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  transpilePackages: ["@fieldframe/domain", "@fieldframe/queue"],
};
module.exports = {
  allowedDevOrigins: ['10.0.0.245'],
}
export default nextConfig;
