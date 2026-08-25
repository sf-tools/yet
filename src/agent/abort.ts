import type { AgentStore } from '@/store';

export function createAbortController(store: AgentStore) {
  const controller = new AbortController();
  resetAbortState(store);
  store.setAbortController(controller);
  return controller;
}

export function resetAbortState(store: AgentStore) {
  store.setAbortConfirmationPending(false);
  store.setAbortRequested(false);
  store.setSteerRequested(false);
}

export function handleAbortKeypress(store: AgentStore) {
  const state = store.getState();
  const controller = state.abortController;

  if (!state.busy || !controller) return false;

  if (!state.abortConfirmationPending) {
    store.setAbortConfirmationPending(true);
    return true;
  }

  store.setAbortConfirmationPending(false);
  store.setAbortRequested(true);
  controller.abort();
  return true;
}
