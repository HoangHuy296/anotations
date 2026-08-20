import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  transpilePackages: ["@annotationplatform/domain", "@annotationplatform/queue"],
};
module.exports = {
  allowedDevOrigins: ['10.0.0.123'],
}
export default nextConfig;
