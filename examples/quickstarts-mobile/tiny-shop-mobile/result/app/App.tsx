// Navigation: Products, Product and Cart in a native stack, around the shared cart.
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { CartProvider } from "./src/cart";
import { navigationRef, setNavigationReady, type RootStackParamList } from "./src/navigation";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";
import { navigationIntegration } from "./src/sentry";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <CartProvider>
      <NavigationContainer
        ref={navigationRef}
        onReady={() => {
          // Sentry starts a `navigation` transaction for every screen change from here on.
          navigationIntegration.registerNavigationContainer(navigationRef);
          setNavigationReady();
        }}
      >
        <Stack.Navigator>
          <Stack.Screen name="Products" component={ProductsScreen} options={{ title: "Tiny Shop" }} />
          <Stack.Screen name="Product" component={ProductScreen} />
          <Stack.Screen name="Cart" component={CartScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="auto" />
    </CartProvider>
  );
}
