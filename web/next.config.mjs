/** @type {import('next').NextConfig} */
const nextConfig = {
  // The entity map lives outside web/ at the repo root; allow reading it.
  outputFileTracingIncludes: { "/": ["../data/entity_map.json"] },
};

export default nextConfig;
