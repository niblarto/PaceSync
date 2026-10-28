/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { instrumentationHook: true }, // instrumentation.ts: restart queued Spotify work on boot
};

export default nextConfig;
