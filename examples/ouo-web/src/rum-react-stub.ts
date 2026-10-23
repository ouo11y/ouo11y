// Local stand-in for @ouo11y/browser/react, used only when VITE_RUM_STUB=1 (see rum-stub.ts).
import { Component, type ReactNode } from "react";

interface BoundaryProps {
  children?: ReactNode;
  fallback?: ReactNode | ((props: { error: unknown; reset: () => void }) => ReactNode);
}

export class OuoErrorBoundary extends Component<BoundaryProps, { error: unknown; hasError: boolean }> {
  override state = { error: null as unknown, hasError: false };
  static getDerivedStateFromError(error: unknown) {
    return { error, hasError: true };
  }
  override componentDidCatch(error: unknown): void {
    console.info("[ouo:stub] error boundary", error);
  }
  reset = () => this.setState({ error: null, hasError: false });
  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    const f = this.props.fallback;
    return typeof f === "function" ? f({ error: this.state.error, reset: this.reset }) : (f ?? null);
  }
}

export function useOuoRoute(template: string | undefined | null): void {
  if (template) console.debug("[ouo:stub] route", template);
}

export function routeTemplate(matches: ReadonlyArray<{ route: { path?: string | undefined } }> | null | undefined): string | undefined {
  if (!matches?.length) return undefined;
  const parts: string[] = [];
  for (const m of matches) {
    const p = m.route.path;
    if (!p) continue;
    if (p.startsWith("/")) parts.length = 0;
    parts.push(p.replace(/^\/+|\/+$/g, ""));
  }
  return "/" + parts.filter(Boolean).join("/");
}
