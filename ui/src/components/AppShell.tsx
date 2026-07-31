import type { ReactNode } from "react";
import { FileText, FlaskConical, GitCompare, Table2, Waypoints } from "lucide-react";
import { NavLink } from "react-router-dom";
import {
  PlatformAccount,
  PlatformShell,
  ThemeToggle,
  platformNavItemClass,
  platformUrlsFromEnv,
} from "@sx/ui";

import { useLogout } from "@/auth";
import type { CurrentUser } from "@/api/types";

const NAV = [
  { to: "/", label: "Runs", icon: Waypoints, end: true },
  { to: "/compare", label: "Compare", icon: GitCompare, end: false },
  { to: "/research", label: "Research", icon: FlaskConical, end: false },
  { to: "/projects", label: "Projects", icon: Table2, end: false },
  { to: "/reports", label: "Reports", icon: FileText, end: false },
] as const;

/* The console's chrome is the platform shell (workspace launcher + nav + the
   account slot). The org is worth showing: it is the tenancy key stamped on
   every row, so it answers "whose runs am I looking at" — not decoration. */
export function AppShell({ user, children }: { user: CurrentUser; children: ReactNode }) {
  const logout = useLogout();

  return (
    <PlatformShell
      activeSurface="autonomy-training"
      urls={platformUrlsFromEnv(import.meta.env)}
      navigation={NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => platformNavItemClass(isActive)}
        >
          <item.icon className="h-4 w-4" />
          {item.label}
        </NavLink>
      ))}
      account={
        <div className="flex items-center gap-1">
          <ThemeToggle storageKey="waddle-theme" />
          <PlatformAccount
            name={user.subject}
            detail={user.org_slug}
            badges={[{ label: user.role, variant: "secondary" }]}
            onSignOut={() => logout.mutate()}
            signingOut={logout.isPending}
          />
        </div>
      }
    >
      <div className="mx-auto w-full max-w-[1400px] p-4 sm:p-6">{children}</div>
    </PlatformShell>
  );
}
