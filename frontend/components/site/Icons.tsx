/** Small stroke icons for cards. Decorative: always aria-hidden. */
const P = {
  width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
} as const;

export const Icon = {
  layers: () => (
    <svg {...P}><path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="m3 13 9 5 9-5" /><path d="m3 17.5 9 5 9-5" opacity=".5" /></svg>
  ),
  link: () => (
    <svg {...P}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="9" cy="18" r="2.5" /><path d="M8.3 7l7.3.8M16.6 10.1l-6.3 5.9M6.6 8.4l1.8 7.2" /></svg>
  ),
  search: () => (
    <svg {...P}><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
  ),
  plug: () => (
    <svg {...P}><path d="M9 2v5M15 2v5" /><path d="M6 7h12v4a6 6 0 0 1-12 0V7Z" /><path d="M12 17v5" /></svg>
  ),
  split: () => (
    <svg {...P}><rect x="3" y="4" width="8" height="16" rx="2" /><rect x="13" y="4" width="8" height="7" rx="2" /><rect x="13" y="13" width="8" height="7" rx="2" /></svg>
  ),
  eye: () => (
    <svg {...P}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
  ),
  shield: () => (
    <svg {...P}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></svg>
  ),
  refresh: () => (
    <svg {...P}><path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4" /></svg>
  ),
  map: () => (
    <svg {...P}><path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2-6-2Z" /><path d="M9 4v14M15 6v14" /></svg>
  ),
  bot: () => (
    <svg {...P}><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01" /><path d="M2 13v2M22 13v2" /></svg>
  ),
  puzzle: () => (
    <svg {...P}><path d="M10 3h4v3a2 2 0 1 0 4 0h3v5h-3a2 2 0 1 0 0 4h3v6h-6v-3a2 2 0 1 0-4 0v3H3v-6h3a2 2 0 1 0 0-4H3V6h7V3Z" /></svg>
  ),
  cpu: () => (
    <svg {...P}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></svg>
  ),
};
