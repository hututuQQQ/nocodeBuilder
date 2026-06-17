import type { AppState } from "./appStore";

type StoreSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
) => void;

export type StoreAccess = {
  get: () => AppState;
  set: StoreSet;
};
