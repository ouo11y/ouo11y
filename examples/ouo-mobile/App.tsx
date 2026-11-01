import { RUMProvider, navigationStateListener } from "@ouo11y/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { AppState, LogBox, Text } from "react-native";

// LogBox's own renderer throws in the iOS 27 dev client and its toast covers the bottom buttons.
// Set EXPO_PUBLIC_QUIET_LOGBOX=1 when starting Metro to silence it (dev builds only).
if (__DEV__ && process.env.EXPO_PUBLIC_QUIET_LOGBOX === "1") {
  LogBox.ignoreAllLogs(true);
}
import type { RootStackParamList } from "./src/navigation";
import { chaos } from "./modules/ouo-chaos";
import { navigationRef, startJourneyMailbox } from "./src/journey";
import { appVersion, note, rum, shortId } from "./src/rum";
import { CartScreen } from "./src/screens/CartScreen";
import { ChaosScreen } from "./src/screens/ChaosScreen";
import { CheckoutScreen } from "./src/screens/CheckoutScreen";
import { OrderScreen } from "./src/screens/OrderScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";
import { styles } from "./src/ui";

const Stack = createNativeStackNavigator<RootStackParamList>();
const onStateChange = navigationStateListener(rum);

/** Header badge: app version and the (rotating) session id. */
function SessionBadge() {
  const [id, setId] = useState(rum.session.id());
  useEffect(() => {
    const t = setInterval(() => setId(rum.session.id()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Text style={styles.mono} testID="session-badge">
      v{appVersion} · {shortId(id)}
    </Text>
  );
}

export default function App() {
  // scripts/journey.sh drives the app through a command file (src/journey.ts).
  useEffect(() => startJourneyMailbox(), []);
  // Conformance notes (tests/e2e/mobile-android): each launch and each return to the foreground, with the session then.
  useEffect(() => {
    note("launch", { action: chaos?.launchAction?.() ?? "" });
    const sub = AppState.addEventListener("change", (s) => s === "active" && note("active"));
    return () => sub.remove();
  }, []);
  return (
    <RUMProvider rum={rum}>
      <NavigationContainer ref={navigationRef} onReady={() => rum.trackNavigation("/Products")} onStateChange={onStateChange}>
        <Stack.Navigator screenOptions={{ headerRight: () => <SessionBadge /> }}>
          <Stack.Screen name="Products" component={ProductsScreen} options={{ title: "mobile-store" }} />
          <Stack.Screen name="Product" component={ProductScreen} />
          <Stack.Screen name="Cart" component={CartScreen} />
          <Stack.Screen name="Checkout" component={CheckoutScreen} />
          <Stack.Screen name="Order" component={OrderScreen} options={{ headerBackVisible: false }} />
          <Stack.Screen name="Chaos" component={ChaosScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="auto" />
    </RUMProvider>
  );
}
