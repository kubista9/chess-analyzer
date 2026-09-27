import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Compass, House, Menu, TriangleAlert, X } from "lucide-react";
import { OWNER_USERNAME } from "../../shared/constants";
import { useNow } from "../hooks/useNow";
import { useWorkspace } from "../hooks/useWorkspace";
import { formatAgo, formatCount } from "../utils/formatters";

const navItems = [
  { to: "/", label: "Home", icon: House, end: true },
  { to: "/explorer", label: "Explorer", icon: Compass, end: false },
  { to: "/leaks", label: "Leaks", icon: TriangleAlert, end: false }
];

export function AppShell() {
  const { status } = useWorkspace();
  const now = useNow();
  const footer = status
    ? [
        OWNER_USERNAME,
        `${formatCount(status.counts.total)} games`,
        status.lastSync ? `synced ${formatAgo(status.lastSync.at, now)}` : "not synced"
      ].join(" · ")
    : OWNER_USERNAME;
  const location = useLocation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isCompact, setIsCompact] = useState(false);
  const isNavAccessible = !isCompact || isMenuOpen;

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1180px)");
    const updateCompactLayout = () => setIsCompact(mediaQuery.matches);

    updateCompactLayout();
    mediaQuery.addEventListener("change", updateCompactLayout);

    return () => mediaQuery.removeEventListener("change", updateCompactLayout);
  }, []);

  useEffect(() => {
    setIsMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!isCompact || !isMenuOpen) {
      return undefined;
    }

    const originalOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMenuOpen(false);
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isCompact, isMenuOpen]);

  return (
    <div className={`app-shell${isMenuOpen ? " mobile-menu-open" : ""}`}>
      <header className="mobile-topbar">
        <Link className="mobile-brand" to="/" aria-label="Go to home">
          <div className="brand-mark">♟</div>
          <div className="mobile-brand-copy">
            <div className="brand-title">Chess Analyst</div>
            <div className="brand-subtitle">Local-first review lab</div>
          </div>
        </Link>

        <button
          className="mobile-menu-button"
          type="button"
          aria-controls="primary-navigation"
          aria-expanded={isMenuOpen}
          aria-label={isMenuOpen ? "Close navigation menu" : "Open navigation menu"}
          onClick={() => setIsMenuOpen((isOpen) => !isOpen)}
        >
          {isMenuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </header>

      <button
        className="mobile-menu-backdrop"
        type="button"
        aria-label="Close navigation menu"
        aria-hidden={!isMenuOpen}
        tabIndex={isMenuOpen ? 0 : -1}
        onClick={() => setIsMenuOpen(false)}
      />

      <aside className="sidebar" id="primary-navigation" aria-hidden={!isNavAccessible}>
        <div className="sidebar-header">
          <Link className="brand" to="/" aria-label="Go to home" tabIndex={isNavAccessible ? undefined : -1}>
            <div className="brand-mark">♟</div>
            <div>
              <div className="brand-title">Chess Analyst</div>
              <div className="brand-subtitle">Local-first review lab</div>
            </div>
          </Link>

          <button
            className="sidebar-close-button"
            type="button"
            aria-label="Close navigation menu"
            tabIndex={isMenuOpen ? 0 : -1}
            onClick={() => setIsMenuOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `nav-link${isActive ? " nav-link-active" : ""}`
                }
                tabIndex={isNavAccessible ? undefined : -1}
                onClick={() => setIsMenuOpen(false)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="footer-label">Current workspace</div>
          <div className="footer-value">{footer}</div>
        </div>
      </aside>

      <main className="page-shell">
        <Outlet />
      </main>
    </div>
  );
}
