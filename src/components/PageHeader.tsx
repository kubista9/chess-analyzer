import { useEffect, type ReactNode } from "react";

export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}

/** A page's eyebrow, one-word title and short explanation; also sets the document title. */
export function PageHeader({ eyebrow, title, children, actions }: PageHeaderProps) {
  useDocumentTitle(title);
  return (
    <header className="page-header">
      <div className="page-header-text">
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {children ? <p>{children}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}

/** Sets "<title> · Opening Trainer" while the page is shown. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title === "Home" ? "Opening Trainer" : `${title} · Opening Trainer`;
  }, [title]);
}
