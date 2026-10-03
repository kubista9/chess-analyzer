import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";

/** Unknown addresses: a way back instead of a blank page. */
export function NotFoundPage() {
  return (
    <div className="page">
      <PageHeader eyebrow="Not found" title="Page not found">
        There is no page at this address.
      </PageHeader>
      <div className="row">
        <Link className="button button-primary" to="/">
          Go to Home
        </Link>
        <Link className="button" to="/practice">
          Practice
        </Link>
      </div>
    </div>
  );
}
