const activeControllers = new Map<string, AbortController>();

export function createRunAbortController(runId: string) {
  const controller = new AbortController();
  activeControllers.set(runId, controller);
  return controller;
}

export function releaseRunAbortController(runId: string) {
  activeControllers.delete(runId);
}

export function requestRunAbort(runId: string) {
  activeControllers.get(runId)?.abort();
}
