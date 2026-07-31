import type { ReactNode } from "react";
import { FileText, FlaskConical, GitCompare, Table2, Waypoints } from "lucide-react";
import { NavLink } from "react-router-dom";
import { PlatformShell, ThemeToggle, platformNavItemClass, platformUrlsFromEnv } from "@sx/ui";

const NAV = [
  { to: "/", label: "Runs", icon: Waypoints, end: true },
  { to: "/compare", label: "Compare", icon: GitCompare, end: false },
  { to: "/research", label: "Research", icon: FlaskConical, end: false },
  { to: "/projects", label: "Projects", icon: Table2, end: false },
  { to: "/reports", label: "Reports", icon: FileText, end: false },
] as const;

/* The console's chrome is the platform shell (workspace launcher + nav + the
   account slot). No org badge: the backend exposes no /api/me, so the console
   has nothing truthful to claim about who or which org is signed in. */
export function AppShell({ children }: { children: ReactNode }) {
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
      account={<ThemeToggle storageKey="waddle-theme" />}
    >
      <div className="mx-auto w-full max-w-[1400px] p-4 sm:p-6">{children}</div>
    </PlatformShell>
  );
}
