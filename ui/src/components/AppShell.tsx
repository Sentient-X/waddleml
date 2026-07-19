import { useEffect, useState, type ReactNode } from "react";
import {
  FileText,
  FlaskConical,
  GitCompare,
  Moon,
  Sun,
  Table2,
  Waypoints,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import {
  Badge,
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
  platformNavItemClass,
} from "@sx/ui";

const NAV = [
  { to: "/", label: "Runs", icon: Waypoints, end: true },
  { to: "/compare", label: "Compare", icon: GitCompare, end: false },
  { to: "/research", label: "Research", icon: FlaskConical, end: false },
  { to: "/projects", label: "Projects", icon: Table2, end: false },
  { to: "/reports", label: "Reports", icon: FileText, end: false },
] as const;

function initialDark(): boolean {
  const saved = window.localStorage.getItem("waddle-theme");
  return saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(initialDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    window.localStorage.setItem("waddle-theme", dark ? "dark" : "light");
  }, [dark]);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card/80 px-3 backdrop-blur sm:gap-3 sm:px-4">
        <div className="flex shrink-0 items-center gap-2 pr-1">
          <span className="grid h-8 w-8 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
            <Waypoints className="h-[18px] w-[18px]" />
          </span>
          <span className="max-sm:hidden">
            <span className="block text-[9px] font-semibold uppercase leading-none tracking-[0.22em] text-muted-foreground">
              Sentient-X
            </span>
            <span className="mt-1 block text-sm font-semibold leading-none tracking-tight">
              Waddle
            </span>
          </span>
        </div>
        <nav className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {NAV.map((item) => (
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
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="font-mono text-[9px] tracking-[0.08em]">
            org · dev-local
          </Badge>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn("h-9 w-9")}
                onClick={() => setDark((current) => !current)}
                aria-label={`Switch to ${dark ? "light" : "dark"} mode`}
              >
                {dark ? <Sun /> : <Moon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Switch to {dark ? "light" : "dark"} mode</TooltipContent>
          </Tooltip>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[1400px] p-4 sm:p-6">{children}</div>
      </main>
    </div>
  );
}
