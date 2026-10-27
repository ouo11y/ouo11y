// Tiny Shop Mobile: three screens in a native stack, the cart shared by all of them.
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { CartProvider } from "./src/cart";
import { navigationRef, setNavigationReady, type Screens } from "./src/navigation";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";
import { navigationIntegration } from "./src/sentry";

const Stack = createNativeStackNavigator<Screens>();

export default function App() {
  return (
    <CartProvider>
      <NavigationContainer
        ref={navigationRef}
        onReady={() => {
          navigationIntegration.registerNavigationContainer(navigationRef);
          setNavigationReady();
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
