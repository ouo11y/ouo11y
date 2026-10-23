/**
 * React integrations for `@ouo11y/browser`, a separate entry (`@ouo11y/browser/react`) so the
 * core stays framework-free. React is a peer dependency; the SDK is imported from the package
 * itself, so this entry shares the one `initRUM` instance with the app.
 */
import { Component, createElement, Fragment, useEffect, type ErrorInfo, type ReactNode } from "react";
import { getRUM, type Attrs } from "@ouo11y/browser";

export interface ErrorBoundaryFallbackProps {
  error: unknown;
  /** Clears the error and renders the children again. */
  reset: () => void;
}

export interface OuoErrorBoundaryProps {
  children?: ReactNode;
  /** Rendered instead of the children after an error. Default nothing. */
  fallback?: ReactNode | ((props: ErrorBoundaryFallbackProps) => ReactNode);
  /** Extra attributes on the `exception` event. */
  attributes?: Attrs;
  /** Called after the error is reported. */
  onError?: (error: unknown, componentStack: string) => void;
}

interface State {
  error: unknown;
  hasError: boolean;
}

export const REACT_EXCEPTION_KIND = "react.error_boundary";

/**
 * Reports render errors of its subtree as `exception` events (`ouo.exception.kind`
 * `react.error_boundary`, handled, with `ouo.react.component_stack`) and renders `fallback`.
 * React 18 in development also rethrows the error to `window`, where the SDK reports it a
 * second time as uncaught; production builds report it once.
 */
export class OuoErrorBoundary extends Component<OuoErrorBoundaryProps, State> {
  override state: State = { error: null, hasError: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? "";
    getRUM()?.captureError(error, {
      ...(this.props.attributes ?? {}),
      "ouo.exception.kind": REACT_EXCEPTION_KIND,
      "ouo.react.component_stack": componentStack.trim(),
    });
    this.props.onError?.(error, componentStack);
  }

  reset = (): void => {
    this.setState({ error: null, hasError: false });
  };

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === "function") return fallback({ error: this.state.error, reset: this.reset });
    return createElement(Fragment, null, fallback ?? null);
  }
}

/**
 * Names the current route by its template (`/products/:id`): `app.screen.name` on the open
 * soft-navigation span and on later spans and events. Call it wherever the matched route is
 * known; with React Router: `useOuoRoute(routeTemplate(matchRoutes(routes, useLocation())))`.
 */
export function useOuoRoute(template: string | undefined | null): void {
  useEffect(() => {
    if (template) getRUM()?.setRoute(template);
  }, [template]);
}

interface RouteMatchLike {
  route: { path?: string | undefined; index?: boolean | undefined };
}

/**
 * Joins the `path` of each matched route (React Router `matchRoutes` output, or any list of
 * `{ route: { path } }`) into one template: `[{path:"/"},{path:"products/:id"}]` gives
 * `/products/:id`. Undefined when nothing matched.
 */
export function routeTemplate(matches: readonly RouteMatchLike[] | null | undefined): string | undefined {
  if (!matches || matches.length === 0) return undefined;
  const parts: string[] = [];
  for (const m of matches) {
    const p = m.route.path;
    if (!p) continue;
    if (p.startsWith("/")) parts.length = 0;
    parts.push(p.replace(/^\/+|\/+$/g, ""));
  }
  return "/" + parts.filter(Boolean).join("/");
}
