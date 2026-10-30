import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Text, View } from "react-native";
import { useCart } from "../cart";
import type { Routes } from "../routes";
import { Button, styles } from "../ui";

export function ProductScreen({ navigation, route }: NativeStackScreenProps<Routes, "Product">) {
  const { product } = route.params;
  const cart = useCart();
  const [added, setAdded] = useState(false);
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{product.name}</Text>
      <Text style={styles.text}>${product.price}</Text>
      <Button
        title="Add to cart"
        testID="add-to-cart"
        onPress={() => {
          cart.add(product);
          setAdded(true);
        }}
      />
      {added ? <Button title="Go to cart" testID="go-to-cart" onPress={() => navigation.navigate("Cart")} /> : null}
    </View>
  );
}
