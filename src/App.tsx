import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { WorkspaceProvider } from "./hooks/useWorkspace";
import { GameHistoryPage } from "./pages/GameHistoryPage";
import { GameReviewPage } from "./pages/GameReviewPage";
import { HomePage } from "./pages/HomePage";
import { OpeningReportPage } from "./pages/OpeningReportPage";

export default function App() {
  return (
    <WorkspaceProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/dashboard" element={<Navigate to="/openings" replace />} />
            <Route path="/history" element={<GameHistoryPage />} />
            <Route path="/review" element={<Navigate to="/history" replace />} />
            <Route path="/review/:gameId" element={<GameReviewPage />} />
            <Route path="/openings" element={<OpeningReportPage />} />
            <Route path="/training" element={<Navigate to="/openings" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WorkspaceProvider>
  );
}
