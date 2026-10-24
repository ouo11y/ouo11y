// "Break it": one button per way a session goes bad. errored = something failed and the user
// carried on; crashed = an uncaught error. Neither ends the session on the web.
import { API, rum } from "./rum";
import { box, h2 } from "./SessionPanel";

export default function BreakItPanel({ onMessage }) {
  function handledError() {
    // Caught and reported: the session becomes `errored`.
    try {
      JSON.parse("{ not json");
    } catch (err) {
      rum.captureError(err, { "app.action": "parse saved cart" });
      onMessage("Handled error reported: session is now errored");
    }
  }

  function uncaughtError() {
    // Thrown and never caught: the SDK's `error` listener reports it as fatal and the session
    // becomes `crashed`. On the web the page keeps working and the session does not end.
    setTimeout(() => {
      throw new Error("Uncaught: cart total is NaN");
    });
    onMessage("Uncaught error thrown: session is now crashed");
  }

  async function failedRequest() {
    // A 500 from the API: the SDK records `http.request.failed`, the session becomes `errored`.
    const res = await fetch(`${API}/api/broken`);
    onMessage(`GET /api/broken answered ${res.status}: session is now errored`);
  }

  return (
    <section style={box}>
      <h2 style={h2}>Break it</h2>
      <button onClick={handledError}>Handled error</button> <button onClick={uncaughtError}>Uncaught error</button>{" "}
      <button onClick={failedRequest}>Failed request</button>
    </section>
  );
}
