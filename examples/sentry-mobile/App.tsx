import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { navigationStateListener, RUMProvider } from "@ouo/react-native";
import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";
import { listenForLinks } from "./src/deeplinks";
import { startMailbox } from "./src/mailbox";
import { navigationRef, type RootStackParamList } from "./src/navigation";
import { markFirstFrame } from "./src/perf";
import { CartScreen } from "./src/screens/CartScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ouo } from "./src/ouo";
import { navigationIntegration } from "./src/sentry";

// `parallel` and `ouo` modes: the ouo SDK wired as its README says (touches as activity,
// navigation events). index.ts initialises ouo after this module loads and before the first
// render, so `ouo` is read at render time, not here.
const OuoRoot = ({ children }: { children: ReactNode }) =>
  ouo ? <RUMProvider rum={ouo}>{children}</RUMProvider> : <Fragment>{children}</Fragment>;

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const unlisten = useRef<(() => void) | null>(null);
  useEffect(() => () => unlisten.current?.(), []);
  const onOuoStateChange = useMemo(() => (ouo ? navigationStateListener(ouo) : undefined), []);

  return (
    <OuoRoot>
      <NavigationContainer
        ref={navigationRef}
        onStateChange={onOuoStateChange}
        onReady={() => {
          markFirstFrame();
          ouo?.trackNavigation("/Home");
          // React Navigation integration: one `navigation` transaction per screen change; a no-op
          // when Sentry was not initialised (`ouo` mode).
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
