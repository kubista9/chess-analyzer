import { NavLink, Outlet } from "react-router-dom";
import { BookOpen, ChartColumnBig, History, Search, Target } from "lucide-react";
import { useWorkspace } from "../hooks/useWorkspace";

const navItems = [
  { to: "/", label: "Dashboard", icon: ChartColumnBig },
  { to: "/history", label: "Game History", icon: History },
  { to: "/review", label: "Post-Game Analysis", icon: Search },
  { to: "/openings", label: "Opening Report", icon: BookOpen },
  { to: "/training", label: "Game Plan", icon: Target }
];

export function AppShell() {
  const { snapshot } = useWorkspace();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">♟</div>
          <div>
            <div className="brand-title">Chess Analyst</div>
            <div className="brand-subtitle">Local-first review lab</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `nav-link${isActive ? " nav-link-active" : ""}`
                }
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="footer-label">Current workspace</div>
          <div className="footer-value">
            {snapshot ? `${snapshot.username} · ${snapshot.limit} games` : "Ready for public Chess.com username"}
          </div>
        </div>
      </aside>

      <main className="page-shell">
        <Outlet />
      </main>
    </div>
  );
}
