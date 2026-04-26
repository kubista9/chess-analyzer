import { useWorkspace } from "../hooks/useWorkspace";

export function TrainingPlanPage() {
  const { snapshot } = useWorkspace();

  return (
    <div className="page-content">
      <section className="page-header">
        <div>
          <span className="eyebrow">Rule-based coaching</span>
          <h1>Personal Game Plan</h1>
          <p>
            This page turns your recurring mistakes into a practical weekly routine instead of a pile of engine numbers.
          </p>
        </div>
      </section>

      {!snapshot ? (
        <section className="panel empty-panel">
          <h2>No training plan yet</h2>
          <p>Run the analysis first and this page will generate a focused improvement plan from your own games.</p>
        </section>
      ) : (
        <>
          <section className="panel training-hero">
            <h2>{snapshot.trainingPlan.headline}</h2>
            <p>{snapshot.trainingPlan.summary}</p>
          </section>

          <section className="dual-grid">
            <article className="panel">
              <span className="eyebrow">Focus areas</span>
              <h2>What to fix first</h2>
              <div className="focus-list">
                {snapshot.trainingPlan.focusAreas.map((area) => (
                  <div className="focus-card" key={area.title}>
                    <h3>{area.title}</h3>
                    <p>{area.reason}</p>
                    <div className="focus-target">{area.targetMetric}</div>
                    <ul className="action-list">
                      {area.actions.map((action) => (
                        <li key={action}>{action}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </article>

            <article className="panel">
              <span className="eyebrow">Weekly rhythm</span>
              <h2>Suggested training week</h2>
              <div className="schedule-list">
                {snapshot.trainingPlan.weeklySchedule.map((session) => (
                  <div className="schedule-card" key={session.day}>
                    <div className="schedule-day">{session.day}</div>
                    <div>
                      <h3>{session.title}</h3>
                      <p>{session.details}</p>
                    </div>
                    <div className="schedule-duration">{session.duration}</div>
                  </div>
                ))}
              </div>
            </article>
          </section>
        </>
      )}
    </div>
  );
}
