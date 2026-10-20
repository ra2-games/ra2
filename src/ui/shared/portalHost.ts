import { createContext, useContext } from 'react';

/** The entry point supplies its existing root; portals never create a second UI host. */
export const PortalHostContext = createContext<HTMLElement | null>(null);

export function usePortalHost(): HTMLElement {
  const host = useContext(PortalHostContext);
  if (!host) throw new Error('UI portals require a PortalHostContext provider');
  return host;
}
