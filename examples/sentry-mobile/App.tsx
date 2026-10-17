import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { navigationStateListener, RUMProvider } from "@ouo/react-native";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { listenForLinks } from "./src/deeplinks";
import { startMailbox } from "./src/mailbox";
import { navigationRef, type RootStackParamList } from "./src/navigation";
import { markFirstFrame } from "./src/perf";
import { CartScreen } from "./src/screens/CartScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ouo } from "./src/ouo";
import { navigationIntegration } from "./src/sentry";

// Parallel mode: the ouo SDK wired as its README says (touches as activity, navigation events).
const OuoRoot = ({ children }: { children: ReactNode }) =>
  ouo ? <RUMProvider rum={ouo}>{children}</RUMProvider> : <Fragment>{children}</Fragment>;
const onOuoStateChange = ouo ? navigationStateListener(ouo) : undefined;

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const unlisten = useRef<(() => void) | null>(null);
  useEffect(() => () => unlisten.current?.(), []);

  return (
    <OuoRoot>
      <NavigationContainer
        ref={navigationRef}
        onStateChange={onOuoStateChange}
        onReady={() => {
          markFirstFrame();
          ouo?.trackNavigation("/Home");
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
    </OuoRoot>
  );
}
