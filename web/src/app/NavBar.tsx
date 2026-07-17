"use client";

import { usePathname } from "next/navigation";
import { ChatIcon, ClockIcon, HomeIcon, MoreIcon, SlidersIcon } from "./icons";

/**
 * The app's five destinations. Renders as a fixed bottom tab bar on phones
 * (thumb-reachable, 48px targets) and a top bar on wider screens — one IA,
 * two presentations (docs/DESIGN_DIRECTION.md review pass).
 */

const TABS = [
  { href: "/", label: "Home", icon: HomeIcon },
  { href: "/assistant", label: "Ask", icon: ChatIcon },
  { href: "/systems", label: "Systems", icon: SlidersIcon },
  { href: "/automations", label: "Automations", icon: ClockIcon },
  { href: "/more", label: "More", icon: MoreIcon },
];

export default function NavBar() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="navbar" aria-label="Main">
      {TABS.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <a key={t.href} href={t.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
            <t.icon />
            <span>{t.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
