// Entry of the bare app: what a client does is the first two lines (initRUM before the first
// render, then the app's own root component). The screens, the journey mailbox and initRUM are the
// golden app's (../ouo-mobile), so the conformance suites drive the same UI on Expo 57 and here.
import "../ouo-mobile/src/rum";
import { AppRegistry } from "react-native";
import App from "../ouo-mobile/App";
import { name as appName } from "./app.json";

AppRegistry.registerComponent(appName, () => App);
