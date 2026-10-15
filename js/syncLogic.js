// Pure decision logic for cloud sync (kept free of the backend SDK and the DOM so it can be unit tested in Node).

/**
 * Decide what to do right after sign-in (or when a remote change arrives).
 *  meta              { uid, rev, dirty } remembered on this device, or null
 *  uid               the signed-in account
 *  remoteRev         revision of the cloud copy, or null when the account has no cloud data yet
 *  localHasProgress  true when this device holds real work (ticked tasks, added/removed tasks)
 * Returns 'none' | 'push' | 'pull' | 'conflict'.
 */
export function decideSync({ meta, uid, remoteRev, localHasProgress }) {
  if (remoteRev === null || remoteRev === undefined) return 'push';
  if (meta && meta.uid === uid) {
    const remoteChanged = remoteRev > meta.rev;
    if (!remoteChanged) return meta.dirty ? 'push' : 'none';
    return meta.dirty ? 'conflict' : 'pull';
  }
  // First time this account is used on this device: take the cloud copy unless there is real local work to protect.
  return localHasProgress ? 'conflict' : 'pull';
}

export function hasLocalProgress(state, libraryTaskCount) {
  // Planning blocks (revision, previews) and split sessions of one lecture come with every plan, so they are not the user's own work.
  const own = state.tasks.filter((t) => !t.generated);
  return new Set(own.map((t) => t.parentId || t.id)).size !== libraryTaskCount || own.some((t) => t.done);
}

export function describeState(s) {
  const lectures = s.tasks.filter((t) => t.type === 'video');
  return `${lectures.filter((t) => t.done).length} of ${lectures.length} lectures done`;
}
