import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WorkspaceProvider } from "./hooks/useWorkspace";
import { AlternativesPage } from "./pages/AlternativesPage";
import { ExplorerPage } from "./pages/ExplorerPage";
import { GameReviewPage } from "./pages/GameReviewPage";
import { HomePage } from "./pages/HomePage";
import { LeaksPage } from "./pages/LeaksPage";
import { RepertoirePage } from "./pages/RepertoirePage";
import { TrainPage } from "./pages/TrainPage";

export default function App() {
  // The outer boundary catches errors in the shell itself; AppShell has one per route.
  return (
    <ErrorBoundary>
      <WorkspaceProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/explorer" element={<ExplorerPage />} />
              <Route path="/leaks" element={<LeaksPage />} />
              <Route path="/repertoire" element={<RepertoirePage />} />
              <Route path="/alternatives" element={<AlternativesPage />} />
              <Route path="/train" element={<TrainPage />} />
              <Route path="/training" element={<Navigate to="/train" replace />} />
              <Route path="/review/:gameId" element={<GameReviewPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </WorkspaceProvider>
    </ErrorBoundary>
  );
}
