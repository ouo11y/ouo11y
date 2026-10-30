import { RUMProvider, navigationStateListener } from "@ouo11y/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { CartProvider } from "./src/cart";
import { JourneyRunner, navigationRef } from "./src/journey";
import type { Routes } from "./src/routes";
import { rum } from "./src/rum";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";

const Stack = createNativeStackNavigator<Routes>();

// The navigation listener turns every screen change into a `navigation` event whose `url.path`
// is the screen (`/Products`, `/Product`, `/Cart`): the funnel's page steps. RUMProvider turns
// every touch into a `ui.tap` event that reads as a user step.
export default function App() {
  return (
    <RUMProvider rum={rum}>
      <CartProvider>
        <NavigationContainer
          ref={navigationRef}
          onReady={() => rum.trackNavigation("/Products")}
          onStateChange={navigationStateListener(rum)}
        >
          <Stack.Navigator>
            <Stack.Screen name="Products" component={ProductsScreen} options={{ title: "Tiny Shop" }} />
            <Stack.Screen name="Product" component={ProductScreen} options={({ route }) => ({ title: route.params.product.name })} />
            <Stack.Screen name="Cart" component={CartScreen} />
          </Stack.Navigator>
        </NavigationContainer>
        <JourneyRunner />
      </CartProvider>
      <StatusBar style="auto" />
    </RUMProvider>
  );
}
