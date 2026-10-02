import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render errors below it and shows a fallback with a reload button instead of a
 * blank app. AppShell keys it by the route, so navigating elsewhere clears the error.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <section className="panel empty-panel error-boundary" role="alert">
        <h2>Something went wrong on this page</h2>
        <p>Your progress is safe: it is stored in this browser. Reload to try again, or go to another page.</p>
        <p className="error-text">{error.message || String(error)}</p>
        <button className="primary-button" type="button" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      </section>
    );
  }
}
