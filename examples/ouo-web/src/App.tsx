import { matchRoutes, useLocation, useRoutes, type RouteObject } from "react-router-dom";
import { OuoErrorBoundary, routeTemplate, useOuoRoute } from "@ouo11y/browser/react";
import { Layout } from "./components/Layout";
import { ProductsPage } from "./pages/ProductsPage";
import { ProductPage } from "./pages/ProductPage";
import { CartPage } from "./pages/CartPage";
import { CheckoutPage } from "./pages/CheckoutPage";
import { OrderPage } from "./pages/OrderPage";
import { ChaosPage } from "./pages/ChaosPage";
import { NotFoundPage } from "./pages/NotFoundPage";

const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <ProductsPage /> },
      { path: "products/:id", element: <ProductPage /> },
      { path: "cart", element: <CartPage /> },
      { path: "checkout", element: <CheckoutPage /> },
      { path: "order/:id", element: <OrderPage /> },
      { path: "chaos", element: <ChaosPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

function PageFailed({ error, reset }: { error: unknown; reset: () => void }) {
  return (
    <section className="page" role="alert" data-testid="page-failed">
      <h1>Something went wrong</h1>
      <p className="muted">{error instanceof Error ? error.message : String(error)}</p>
      <button type="button" className="btn" onClick={reset}>
        Try again
      </button>
    </section>
  );
}

export default function App() {
  const location = useLocation();
  // `app.screen.name` = the matched route template (`/products/:id`), via @ouo11y/browser/react.
  // The cast: react-router's RouteObject and AgnosticRouteObject disagree under exactOptionalPropertyTypes.
  useOuoRoute(routeTemplate(matchRoutes(routes as Parameters<typeof matchRoutes>[0], location)));
  const element = useRoutes(routes);
  return (
    <OuoErrorBoundary key={location.pathname} fallback={(p) => <PageFailed {...p} />}>
      {element}
    </OuoErrorBoundary>
  );
}
