import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { listenForLinks } from "./src/deeplinks";
import { startMailbox } from "./src/mailbox";
import { navigationRef, type RootStackParamList } from "./src/navigation";
import { CartScreen } from "./src/screens/CartScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { navigationIntegration } from "./src/sentry";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const unlisten = useRef<(() => void) | null>(null);
  useEffect(() => () => unlisten.current?.(), []);

  return (
    <>
      <NavigationContainer
        ref={navigationRef}
        onReady={() => {
          // React Navigation integration: one `navigation` transaction per screen change.
          navigationIntegration.registerNavigationContainer(navigationRef);
          if (!unlisten.current) {
            const stopLinks = listenForLinks();
            const stopMailbox = startMailbox();
            unlisten.current = () => {
              stopLinks();
              stopMailbox();
            };
          }
        }}
      >
        <Stack.Navigator>
          <Stack.Screen name="Home" component={HomeScreen} options={{ title: "sentry-demo" }} />
          <Stack.Screen name="Product" component={ProductScreen} />
          <Stack.Screen name="Cart" component={CartScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="auto" />
    </>
  );
}
