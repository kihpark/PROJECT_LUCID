/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // typedRoutes was experimental in Next <=14 but is stable in 15+.
  // Keeping it under `experimental.typedRoutes` produces a deprecation
  // warning on every cold start (B-32 cleanup).
  typedRoutes: true,
  // B-32: `output: 'standalone'` was set in PR-4A-1 for a future
  // container-size optimisation that we never actually deployed.
  // Combined with the Dockerfile CMD `pnpm start` (-> `next start`)
  // Next.js 15 prints
  //   "next start" does not work with "output: standalone" configuration.
  //    Use "node .next/standalone/server.js" instead.
  // and silently keeps serving the build's static prerender output,
  // so every frontend change after the initial build was invisible
  // until the container was rebuilt against a different mode. Removing
  // standalone for beta — re-add together with a Dockerfile CMD change
  // (`node .next/standalone/server.js`) only if image size becomes a
  // production deploy constraint.
  env: {
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000',
  },
};

export default nextConfig;
