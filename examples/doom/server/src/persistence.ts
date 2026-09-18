import { JsonFileStore } from '@multiverse/gameplay-harness/node';
import type { SessionCheckpoint } from './session.ts';

// Preserve the existing demo snapshot shape. Its version/import policy belongs
// to the consuming application, not the generic storage implementation.
export class SessionStore extends JsonFileStore<SessionCheckpoint> {
  constructor(path: string) {
    super(path, value => {
      if (!value || typeof value !== 'object' || !('version' in value) || (value.version !== 1 && value.version !== 2 && value.version !== 3)
        || !('worlds' in value) || !Array.isArray(value.worlds) || !('view' in value)
        || !value.view || typeof value.view !== 'object' || !('mainId' in value.view)
        || typeof value.view.mainId !== 'string') throw new Error('Unsupported or invalid session file');
      return value as SessionCheckpoint;
    });
  }
}
