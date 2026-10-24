// What the SDK has stored about the session, the user and the device, read straight from
// localStorage for the "Your session" panel.
//
// Why not rum.session.id()? It starts a new session when the last one has ended: calling it every
// second to refresh the panel would itself be activity. Reading the stored records has no side
// effects, so after "End session" or an inactivity timeout you can see the session marked ended
// until your next click starts the next one.
function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

export function storedSession() {
  // ouo.session: { id, startedAt, lastActivity, previousId?, endedAt?, endReason? }
  // ouo.user:    { id, anonymous }     ouo.device: { id }
  return { session: read("ouo.session"), user: read("ouo.user"), device: read("ouo.device") };
}
