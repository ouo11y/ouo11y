// Product: the detail of one product, and "Add to cart".
import { Image, Text, View } from "react-native";
import { formatPrice } from "../api";
import { useCart } from "../cart";
import type { ScreenProps } from "../navigation";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";

export function ProductScreen({ route, navigation }: ScreenProps<"Product">) {
  const { product } = route.params;
  const cart = useCart();

  const add = () => {
    cart.add(product);
    Sentry.logger.info(`cart.add ${product.name}`, { "product.id": product.id });
  };

  return (
    <View style={styles.screen}>
      <Image source={require("../../assets/icon.png")} style={{ width: "100%", height: 200, borderRadius: 12 }} resizeMode="contain" />
      <Text style={styles.name}>{product.name}</Text>
      {/* Unmask: the price shows in the replay even when masking is on. */}
      <Sentry.Unmask>
        <Text style={styles.price}>{formatPrice(product.price)}</Text>
      </Sentry.Unmask>
      <Text style={styles.note}>{product.description}</Text>
      <Button label="Add to cart" onPress={add} />
      <Button label={`Go to cart (${cart.count})`} onPress={() => navigation.navigate("Cart")} />
    </View>
  );
}
