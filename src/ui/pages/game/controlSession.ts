import { ControlSession } from '../../../app/session/controlSession';
import { createControlJournal } from './state/controlJournal';

export const controlJournal = createControlJournal();
export const controlSession = new ControlSession(controlJournal.activity);
