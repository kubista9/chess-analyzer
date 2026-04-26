import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { WorkspaceProvider } from "./hooks/useWorkspace";
import { DashboardPage } from "./pages/DashboardPage";
import { GameHistoryPage } from "./pages/GameHistoryPage";
import { GameReviewPage } from "./pages/GameReviewPage";
import { OpeningReportPage } from "./pages/OpeningReportPage";
import { TrainingPlanPage } from "./pages/TrainingPlanPage";

export default function App() {
  return (
    <WorkspaceProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/history" element={<GameHistoryPage />} />
            <Route path="/review" element={<GameReviewPage />} />
            <Route path="/review/:gameId" element={<GameReviewPage />} />
            <Route path="/openings" element={<OpeningReportPage />} />
            <Route path="/training" element={<TrainingPlanPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WorkspaceProvider>
  );
}
