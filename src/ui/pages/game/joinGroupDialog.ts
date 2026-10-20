import { groupVisible } from './state/uiState';
export function openGroupJoinDialog(): void {
  groupVisible.set(true);
}
