import { Navigate, Route, Routes } from "react-router-dom";
import { Waypoints } from "lucide-react";
import { EmptyState } from "@sx/ui";

import { AppShell } from "@/components/AppShell";
import { RunsPage } from "@/pages/RunsPage";
import { RunDetailPage } from "@/pages/RunDetailPage";
import { ComparePage } from "@/pages/ComparePage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { ReportsPage } from "@/pages/ReportsPage";
import { ResearchPage } from "@/pages/ResearchPage";
import { ReportViewPage } from "@/pages/ReportViewPage";
import { ReportEditorPage } from "@/pages/ReportEditorPage";

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<RunsPage />} />
        <Route path="/runs/:runId" element={<RunDetailPage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/research" element={<ResearchPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/reports/new" element={<ReportEditorPage isNew />} />
        <Route path="/reports/:id" element={<ReportViewPage />} />
        <Route path="/reports/:id/edit" element={<ReportEditorPage />} />
        <Route
          path="/not-found"
          element={
            <div className="grid h-full place-items-center py-16">
              <EmptyState
                icon={<Waypoints />}
                title="Not part of the console"
                hint="This route isn't a waddle console surface."
              />
            </div>
          }
        />
        <Route path="*" element={<Navigate to="/not-found" replace />} />
      </Routes>
    </AppShell>
  );
}
