import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { MentalOmegaPackageKind } from '../../../../games/mentalOmega/installation';
import type { GameSource } from '../../../../games/source';
import { createGameSourcePicker } from '../gameSourcePicker';
import { useStore } from '../../../shared/state/useStore';

/** Click the file input within a user gesture; React handles all other ordinary UI events and display. */
export function useGameSourcePicker(onSelected: (source: GameSource) => void) {
  const [service] = useState(() => createGameSourcePicker(onSelected));
  const state = useStore(service);
  const archiveRef = useRef<HTMLInputElement>(null);
  const moRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const moKind = useRef<MentalOmegaPackageKind | undefined>(undefined);
  const cancelPick = () => {
    if (pending.current) {
      pending.current = false;
      service.cancelPick();
    }
  };
  useEffect(() => {
    void service.restore();
    let timer = 0;
    const focus = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!archiveRef.current?.files?.length && !folderRef.current?.files?.length && !moRef.current?.files?.length)
          cancelPick();
      }, 200);
    };
    window.addEventListener('focus', focus);
    // React does not expose file-input cancel yet; supplement this one browser API with a listener inside the hook.
    const inputs = [archiveRef.current, folderRef.current, moRef.current];
    for (const input of inputs) input?.addEventListener('cancel', cancelPick);
    return () => {
      for (const input of inputs) input?.removeEventListener('cancel', cancelPick);
      window.removeEventListener('focus', focus);
      window.clearTimeout(timer);
      service.dispose();
    };
  }, [service]);
  const pick = (kind: 'archive' | 'folder' | 'mo') => {
    service.beginPick();
    pending.current = true;
    (kind === 'archive' ? archiveRef : kind === 'mo' ? moRef : folderRef).current?.click();
  };
  const change = (kind: 'archive' | 'folder' | 'mo', event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    pending.current = false;
    if (!files.length) {
      service.cancelPick();
      return;
    }
    // The focus fallback may settle as canceled first; a late change must still perform the full import and preserve the user's selection.
    if (kind === 'mo') void service.importMoPackages(files, moKind.current);
    else if (kind === 'archive') void service.importArchive(files[0]!);
    else void service.importFolder(files);
  };
  return {
    ...state,
    moRef,
    archiveRef,
    folderRef,
    pick,
    pickMoPackage: (kind: MentalOmegaPackageKind) => {
      moKind.current = kind;
      pick('mo');
    },
    cancelPick,
    chooseGame: service.chooseGame,
    clearCache: service.clearCache,
    removeMoPackage: service.removeMoPackage,
    moChanged: (event: ChangeEvent<HTMLInputElement>) => change('mo', event),
    archiveChanged: (event: ChangeEvent<HTMLInputElement>) => change('archive', event),
    folderChanged: (event: ChangeEvent<HTMLInputElement>) => change('folder', event),
  };
}
