import { useEffect, useState } from "react";
import { Button, FlatList, StyleSheet, Text, View } from "react-native";
import { RUMProvider } from "@ouo11y/react-native";
import { StatusBar } from "expo-status-bar";
import { rum } from "./src/rum";

type Product = { id: number; name: string; price: number };

// The product list is the web app's file (guide 01): run `npm run dev` in web/ first.
const PRODUCTS_URL = process.env.EXPO_PUBLIC_PRODUCTS_URL ?? "http://localhost:5173/products.json";

export default function App() {
  const [screen, setScreen] = useState<"Products" | "Cart">("Products");
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Product[]>([]);

  useEffect(() => {
    fetch(PRODUCTS_URL).then((r) => r.json()).then(setProducts).catch(() => setProducts([]));
  }, []);

  const go = (to: "Products" | "Cart") => {
    setScreen(to);
    rum.trackNavigation(`/${to}`); // a screen change: navigation event, new replay view
  };
  useEffect(() => rum.trackNavigation("/Products"), []);

  const add = (p: Product) => {
    setCart([...cart, p]);
    rum.recordEvent("add_to_cart", { "product.name": p.name, "product.price": p.price });
  };
  const checkout = () => {
    // A bug on purpose: a product has no `total`, so this throws a TypeError.
    const total = (cart[0] as any).total.toFixed(2);
    alert(`Paid ${total} €`);
  };

  return (
    <RUMProvider rum={rum}>
      <View style={styles.page}>
        <Text style={styles.title}>Tiny Shop</Text>
        <View style={styles.row}>
          <Button title="Products" onPress={() => go("Products")} />
          <Button title={`Cart (${cart.length})`} onPress={() => go("Cart")} />
          <Button title="Sign in as alice" onPress={() => rum.setUser("alice")} />
        </View>
        {screen === "Products" ? (
          <FlatList
            data={products}
            keyExtractor={(p) => String(p.id)}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <Text style={styles.item}>{item.name}, {item.price} €</Text>
                <Button title="Add to cart" onPress={() => add(item)} />
              </View>
            )}
          />
        ) : (
          <View style={styles.cart}>
            {cart.map((p, i) => <Text key={i} style={styles.item}>{p.name}</Text>)}
            <Button title="Checkout" onPress={checkout} disabled={cart.length === 0} />
          </View>
        )}
        <StatusBar style="auto" />
      </View>
    </RUMProvider>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff", paddingTop: 60 },
  title: { fontSize: 28, fontWeight: "600", margin: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16 },
  item: { fontSize: 18, paddingVertical: 8 },
  cart: { paddingHorizontal: 16, alignItems: "flex-start" },
});
