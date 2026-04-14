/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:3000'],
    },
  },
  // Disable TypeScript incremental compilation cache to prevent stale type errors
  typescript: {
    ignoreBuildErrors: false,
  },
}

module.exports = nextConfig
