/**
 * Tiny inline icon set, stroke-based, drawn in currentColor so every icon
 * follows the theme. Replaces the ad-hoc emoji/glyphs (💡❄️🪟 ⌂ ▦) that
 * rendered differently on every OS.
 */

function I({ d, size = 22, filled = false }: { d: React.ReactNode; size?: number; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {d}
    </svg>
  );
}

export const HomeIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h5v-6h4v6h5V9.5" /></>} />
);

export const ChatIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3c-1.3 0-2.6-.3-3.7-.8L3 20l1.1-5.3a8 8 0 0 1-.6-3.2A8.4 8.4 0 0 1 12 3.2a8.4 8.4 0 0 1 9 8.3Z" />} />
);

export const SlidersIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<><path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5" /><circle cx="15.5" cy="7" r="2" /><circle cx="7.5" cy="12" r="2" /><circle cx="12.5" cy="17" r="2" /></>} />
);

export const ClockIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></>} />
);

/** Marks the Control4-programmed scene pills: fixed by the installer, not editable in the app. */
export const LockIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>} />
);

export const MoreIcon = ({ size }: { size?: number }) => (
  <I size={size} filled d={<><circle cx="5" cy="12" r="1.9" stroke="none" /><circle cx="12" cy="12" r="1.9" stroke="none" /><circle cx="19" cy="12" r="1.9" stroke="none" /></>} />
);

export const BulbIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<><path d="M9 18h6M10 21h4" /><path d="M12 3a6.5 6.5 0 0 0-4 11.6c.8.7 1.4 1.5 1.6 2.4h4.8c.2-.9.8-1.7 1.6-2.4A6.5 6.5 0 0 0 12 3Z" /></>} />
);

export const SnowIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" /><path d="M12 3l-2 2.2M12 3l2 2.2M12 21l-2-2.2M12 21l2-2.2M4.2 7.5l2.9.5M4.2 16.5l2.9-.5M19.8 7.5l-2.9.5M19.8 16.5l-2.9-.5" /></>} />
);

export const BlindsIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<><rect x="4" y="3.5" width="16" height="17" rx="1.5" /><path d="M4 8h16M4 12.5h16" /><path d="M12 12.5v4.5" /><circle cx="12" cy="18.3" r="0.9" /></>} />
);

export const PulseIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<path d="M3 12h4l2.5-6 4 12 2.5-6h5" />} />
);

export const UsersIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<><circle cx="9" cy="8" r="3.4" /><path d="M3 20c.5-3.4 3-5.4 6-5.4s5.5 2 6 5.4" /><path d="M16.5 4.9a3.4 3.4 0 0 1 0 6.4M21 20c-.3-2.4-1.6-4.1-3.5-4.9" /></>} />
);

export const KeyIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<><circle cx="8" cy="15.5" r="4.2" /><path d="M11 12.5 20 3.5M16 7.5l2.7 2.7M13.4 10.1l2.2 2.2" /></>} />
);

export const SignOutIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<><path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14" /><path d="M10 12h10M17 8.5l3.5 3.5-3.5 3.5" /></>} />
);

export const FlameIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<path d="M12 21c3.9 0 6.5-2.4 6.5-6 0-2.5-1.4-4.3-2.7-5.9-.5-.6-1.3-.3-1.4.4-.1.8-.4 1.5-.9 2-.2-2.6-1.5-5.6-3.9-7.3-.5-.4-1.2 0-1.2.6.1 1.9-.6 3.3-1.6 4.7-1 1.5-2.3 3-2.3 5.5 0 3.6 2.6 6 7.5 6Z" />} />
);

export const MapIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<><path d="M3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2-6-2Z" /><path d="M9 4.7v12.6M15 6.7v12.6" /></>} />
);

export const GridIcon = ({ size }: { size?: number }) => (
  <I size={size} d={<><rect x="4" y="4" width="6.8" height="6.8" rx="1.4" /><rect x="13.2" y="4" width="6.8" height="6.8" rx="1.4" /><rect x="4" y="13.2" width="6.8" height="6.8" rx="1.4" /><rect x="13.2" y="13.2" width="6.8" height="6.8" rx="1.4" /></>} />
);
