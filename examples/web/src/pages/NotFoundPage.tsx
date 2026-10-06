import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <section className="page">
      <h1>Not found</h1>
      <p>
        Nothing here. <Link to="/">Back to products</Link>
      </p>
    </section>
  );
}
