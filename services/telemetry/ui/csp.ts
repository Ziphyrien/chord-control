// SvelteKit's compiled route announcer uses this fixed, verified style attribute.
export const dashboardCsp =
  "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-hashes' 'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function createDashboardCsp(): string {
  // Cloudflare reads the response header and adds its nonce to JavaScript Detections.
  // Generate per response; the Worker also sends Cache-Control: no-store.
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return dashboardCsp.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`);
}
