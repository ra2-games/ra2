/** The session owns only startup and destruction; input, debugging, and game controls belong to their respective consumers. */
export interface SessionRuntime {
  start(): Promise<void>;
  destroy(): Promise<void>;
}
