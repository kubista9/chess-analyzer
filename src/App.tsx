import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppDataProvider } from "./app/AppData";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DashboardPage } from "./pages/DashboardPage";

// Routes. Home is bundled with the shell; the other pages load on first visit.
const RepertoirePage = lazy(() => import("./pages/RepertoirePage").then((module) => ({ default: module.RepertoirePage })));
const LinePage = lazy(() => import("./pages/LinePage").then((module) => ({ default: module.LinePage })));
const PracticePage = lazy(() => import("./pages/PracticePage").then((module) => ({ default: module.PracticePage })));
const NextMovePage = lazy(() => import("./pages/practice/NextMovePage").then((module) => ({ default: module.NextMovePage })));
const PlayLinePage = lazy(() => import("./pages/practice/PlayLinePage").then((module) => ({ default: module.PlayLinePage })));
const RecallPage = lazy(() => import("./pages/practice/RecallPage").then((module) => ({ default: module.RecallPage })));
const SparringPage = lazy(() => import("./pages/practice/SparringPage").then((module) => ({ default: module.SparringPage })));
const ProgressPage = lazy(() => import("./pages/ProgressPage").then((module) => ({ default: module.ProgressPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then((module) => ({ default: module.NotFoundPage })));

function Lazy({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <p className="loading page" role="status">
          Loading…
        </p>
      }
    >
      {children}
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppDataProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<DashboardPage />} />
              <Route path="repertoire" element={<Lazy><RepertoirePage /></Lazy>} />
              <Route path="repertoire/line/:lineId" element={<Lazy><LinePage /></Lazy>} />
              <Route path="practice" element={<Lazy><PracticePage /></Lazy>} />
              <Route path="practice/next-move" element={<Lazy><NextMovePage /></Lazy>} />
              <Route path="practice/play-line" element={<Lazy><PlayLinePage /></Lazy>} />
              <Route path="practice/recall" element={<Lazy><RecallPage /></Lazy>} />
              <Route path="practice/sparring" element={<Lazy><SparringPage /></Lazy>} />
              <Route path="progress" element={<Lazy><ProgressPage /></Lazy>} />
              <Route path="settings" element={<Lazy><SettingsPage /></Lazy>} />
              <Route path="*" element={<Lazy><NotFoundPage /></Lazy>} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AppDataProvider>
    </ErrorBoundary>
  );
}
