export type SpecExecutionCancellationRequest = {
  conversationId: string;
  modeChangedAt: string;
  projectId: string;
  specId: string;
};

const cancellationRequests = new Map<string, SpecExecutionCancellationRequest>();

export function requestSpecExecutionCancellation(
  request: SpecExecutionCancellationRequest,
) {
  cancellationRequests.set(request.specId, request);
}

export function getSpecExecutionCancellationRequest({
  conversationId,
  projectId,
  specId,
}: Omit<SpecExecutionCancellationRequest, "modeChangedAt">) {
  const request = cancellationRequests.get(specId);

  if (
    !request ||
    request.projectId !== projectId ||
    request.conversationId !== conversationId
  ) {
    return null;
  }

  return request;
}

export function isSpecExecutionCancellationRequested(
  input: Omit<SpecExecutionCancellationRequest, "modeChangedAt">,
) {
  return Boolean(getSpecExecutionCancellationRequest(input));
}

export function clearSpecExecutionCancellation(specId: string) {
  cancellationRequests.delete(specId);
}

export function clearAllSpecExecutionCancellationsForTests() {
  cancellationRequests.clear();
}
