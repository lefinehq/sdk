import type { NextConfig } from "next";

// What create-next-app 16.4 turns on. lefine works with both: app/[locale]/layout.tsx is the root layout.
const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
