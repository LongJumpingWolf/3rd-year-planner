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
  return state.tasks.length !== libraryTaskCount || state.tasks.some((t) => t.done);
}

export function describeState(s) {
  const done = s.tasks.filter((t) => t.done).length;
  return `${done} of ${s.tasks.length} tasks done`;
}
