import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { WorkspaceProvider } from "./hooks/useWorkspace";
import { ExplorerPage } from "./pages/ExplorerPage";
import { GameReviewPage } from "./pages/GameReviewPage";
import { HomePage } from "./pages/HomePage";

// Routes of removed pages (the Opening Report, Game History and older ones) lead to the Explorer.
const LEGACY_ROUTES = ["/openings", "/history", "/dashboard", "/training", "/review"];

export default function App() {
  return (
    <WorkspaceProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/explorer" element={<ExplorerPage />} />
            <Route path="/review/:gameId" element={<GameReviewPage />} />
            {LEGACY_ROUTES.map((path) => (
              <Route key={path} path={path} element={<Navigate to="/explorer" replace />} />
            ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WorkspaceProvider>
  );
}
