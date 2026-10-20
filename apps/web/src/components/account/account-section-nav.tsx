"use client";

import { BellSimple, Export, Eye, Lifebuoy, Translate, UserCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { accountSectionFromHash, accountSectionIds, type AccountSectionId } from "@/lib/account/account-section";

const sections = [
  { id: "account", label: "Account & subscription", icon: UserCircle },
  { id: "notifications", label: "Notifications", icon: BellSimple },
  { id: "exports", label: "Exports & downloads", icon: Export },
  { id: "language", label: "Language", icon: Translate },
  { id: "accessibility", label: "Accessibility", icon: Eye },
  { id: "support", label: "Support", icon: Lifebuoy },
] as const;

export function AccountSectionNav() {
  const [active, setActive] = useState<AccountSectionId>(sections[0].id);
  // A click or hash change scrolls to its section; scroll-spy stays quiet until that scroll settles so the clicked item is not overridden mid-animation.
  const lockedUntil = useRef(0);

  useEffect(() => {
    const syncHash = () => { lockedUntil.current = Date.now() + 900; setActive(accountSectionFromHash(window.location.hash)); };
    syncHash();
    lockedUntil.current = 0;
    // Scroll-spy: the active section is the last one whose top has passed the reading line near the top of the viewport; at the page bottom it is the final section.
    let frame = 0;
    const spy = () => {
      frame = 0;
      if (Date.now() < lockedUntil.current) return;
      const line = Math.min(160, window.innerHeight * 0.3);
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let current: AccountSectionId = sections[0].id;
      for (const section of sections) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= line) current = section.id;
      }
      setActive(atBottom && window.scrollY > 0 ? sections[sections.length - 1].id : current);
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(spy); };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    window.addEventListener("hashchange", syncHash);
    window.addEventListener("popstate", syncHash);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("hashchange", syncHash);
      window.removeEventListener("popstate", syncHash);
    };
  }, []);

  return (
    <nav aria-label="Settings sections" data-active-section={active} data-section-count={accountSectionIds.length} className="hidden lg:sticky lg:top-8 lg:block lg:space-y-1">
      {sections.map((section) => {
        const Icon = section.icon;
        const isActive = active === section.id;
        return (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={isActive ? "location" : undefined}
            className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${isActive ? "bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-200 dark:bg-sky-950/60 dark:text-sky-300 dark:ring-sky-900" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"}`}
          >
            <Icon aria-hidden="true" size={17} />
            {section.label}
          </a>
        );
      })}
    </nav>
  );
}
