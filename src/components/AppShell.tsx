import { useMemo } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { BookOpen, ChartNoAxesColumn, House, Settings as SettingsIcon, Target } from "lucide-react";
import { useAppData } from "../app/AppData";
import { ENGINE_STATUS_LABELS, useEngineSettingsSync, useEngineStatus } from "../app/engine";
import { dueCount } from "../core/training/queue";
import { useNow } from "../hooks/useNow";
import { ErrorBoundary } from "./ErrorBoundary";

const NAV_ITEMS = [
  { to: "/", label: "Home", icon: House, end: true },
  { to: "/repertoire", label: "Repertoire", icon: BookOpen, end: false },
  { to: "/practice", label: "Practice", icon: Target, end: false },
  { to: "/progress", label: "Progress", icon: ChartNoAxesColumn, end: false },
  { to: "/settings", label: "Settings", icon: SettingsIcon, end: false }
] as const;

/** The app chrome: a sidebar on wide screens, a top bar and bottom tabs on phones. */
export function AppShell() {
  const { items, positions, saveError } = useAppData();
  const location = useLocation();
  const now = useNow(60_000);
  useEngineSettingsSync();
  const engineStatus = useEngineStatus();

  const due = useMemo(() => dueCount([...items.white, ...items.black], positions, now), [items, positions, now]);
  const dueLabel = due > 0 ? `${due} position${due === 1 ? "" : "s"} due` : null;

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Main">
        <Brand />
        <nav className="nav" aria-label="Sections">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className="nav-link">
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
              {to === "/practice" && dueLabel ? (
                <span className="nav-count" aria-label={dueLabel}>
                  {due}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="engine-state">
            <span className={`engine-dot engine-dot-${engineStatus}`} aria-hidden="true" />
            {ENGINE_STATUS_LABELS[engineStatus]}
          </span>
          <span>Your progress is stored in this browser.</span>
        </div>
      </aside>

      <header className="topbar">
        <Brand compact />
        <span className="engine-state small muted">
          <span className={`engine-dot engine-dot-${engineStatus}`} aria-hidden="true" />
          <span className="visually-hidden">{ENGINE_STATUS_LABELS[engineStatus]}</span>
        </span>
      </header>

      <main className="main" id="main" tabIndex={-1}>
        {saveError ? (
          <p className="notice notice-danger page save-error" role="alert">
            {saveError}
          </p>
        ) : null}
        <ErrorBoundary key={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>

      <nav className="tabbar" aria-label="Sections">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="tab-link">
            <Icon size={20} aria-hidden="true" />
            <span>{label}</span>
            {to === "/practice" && dueLabel ? (
              <span className="nav-count" aria-label={dueLabel}>
                {due}
              </span>
            ) : null}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <NavLink to="/" className="brand" aria-label="Opening Trainer, home">
      <span className="brand-mark" aria-hidden="true">
        ♞
      </span>
      <span>
        <span className="brand-name">Opening Trainer</span>
        {compact ? null : <span className="brand-tagline">Learn, practise, retain</span>}
      </span>
    </NavLink>
  );
}
