// Shields-style SVG status badge, rendered by hand — no dependencies.
const COLORS: Record<string, string> = {
  passed: "#3fb950",
  failed: "#f85149",
  running: "#d29922",
  queued: "#8b949e",
  canceled: "#8b949e",
  error: "#f85149",
  unknown: "#8b949e",
};

export function badge(status: string): string {
  const color = COLORS[status] ?? COLORS.unknown;
  const label = "forge";
  const labelW = 46;
  const statusW = 12 + status.length * 7;
  const w = labelW + statusW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${status}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${statusW}" height="20" fill="${color}"/>
    <rect width="${w}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="14">${label}</text>
    <text x="${labelW + statusW / 2}" y="14">${status}</text>
  </g>
</svg>`;
}
