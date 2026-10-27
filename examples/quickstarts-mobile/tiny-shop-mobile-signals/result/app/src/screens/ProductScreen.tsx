import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useLayoutEffect } from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import { formatPrice } from "../api";
import { useCart } from "../cart";
import type { RootStackParamList } from "../navigation";
import { Sentry } from "../sentry";

export function ProductScreen() {
  const navigation = useNavigation();
  const { product } = useRoute<RouteProp<RootStackParamList, "Product">>().params;
  const cart = useCart();

  useLayoutEffect(() => navigation.setOptions({ title: product.name }), [navigation, product.name]);

  const addToCart = () => {
    cart.add(product);
    // The log body is the Loki line; the attributes are searchable next to it.
    Sentry.logger.info(Sentry.logger.fmt`Added ${product.name} to cart`, {
      "product.id": product.id,
      "cart.items": cart.items.length + 1,
    });
    navigation.goBack();
  };

  return (
    <View style={styles.page}>
      <Text style={styles.name}>{product.name}</Text>
      <Text style={styles.price}>{formatPrice(product.price)}</Text>
      <Button title="Add to cart" onPress={addToCart} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 12 },
  name: { fontSize: 28, fontWeight: "700" },
  price: { fontSize: 20 },
});
