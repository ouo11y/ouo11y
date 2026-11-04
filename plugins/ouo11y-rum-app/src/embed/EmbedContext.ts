import { createContext, useContext } from 'react';

/**
 * Set when a page renders inside another plugin as an exposed component (ADR-0019). The pages
 * read their time range, scope and filters from the URL query (`useSearchParams`); embedded,
 * that query is built from the component's props instead of the host page's URL, which belongs
 * to the host. `null` (the default) means the page is one of ouo's own routes.
 */
export interface EmbedState {
  /** Query the page reads instead of the browser URL (`from`, `to`, `project`, `service`, ...). */
  search: URLSearchParams;
}

export const EmbedContext = createContext<EmbedState | null>(null);

/** The embed state, or `null` on ouo's own pages. */
export function useEmbed(): EmbedState | null {
  return useContext(EmbedContext);
}
