import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Text, View } from "react-native";
import { useCart } from "../cart";
import type { Routes } from "../routes";
import { Button, styles } from "../ui";

export function ProductScreen({ navigation, route }: NativeStackScreenProps<Routes, "Product">) {
  const { product } = route.params;
  const cart = useCart();
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{product.name}</Text>
      <Text style={styles.text}>${product.price}</Text>
      <Button
        title="Add to cart"
        testID="add-to-cart"
        onPress={() => {
          cart.add(product);
          navigation.navigate("Cart");
        }}
      />
    </View>
  );
}
