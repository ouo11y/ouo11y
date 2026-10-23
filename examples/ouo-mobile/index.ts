// The SDK must initialise before the first render so the global error handler and the
// fetch wrapper are in place for everything the app does.
import "./src/rum";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
