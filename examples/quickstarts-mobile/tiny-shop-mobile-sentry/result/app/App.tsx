// The app: three screens in a native stack. Sentry starts first (src/sentry.ts) and wraps the app.
import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { navigationIntegration, Sentry } from "./src/sentry";
import { markNavigationReady, type Product } from "./src/api";
import { CartProvider } from "./src/cart";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";

export type Screens = { Products: undefined; Product: { product: Product }; Cart: undefined };

const Stack = createNativeStackNavigator<Screens>();
const navigationRef = createNavigationContainerRef<Screens>();

function App() {
  return (
    <CartProvider>
      <NavigationContainer
        ref={navigationRef}
        onReady={() => {
          // Each screen becomes a `navigation` transaction in Sentry, and a screen view in ouo.
          navigationIntegration.registerNavigationContainer(navigationRef);
          markNavigationReady();
        }}
      >
        <Stack.Navigator>
          <Stack.Screen name="Products" component={ProductsScreen} options={{ title: "Tiny Shop" }} />
          <Stack.Screen name="Product" component={ProductScreen} options={({ route }) => ({ title: route.params.product.name })} />
          <Stack.Screen name="Cart" component={CartScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="auto" />
    </CartProvider>
  );
}

export default Sentry.wrap(App);
