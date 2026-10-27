// Product: one product and "Add to cart".
import { Text, View } from "react-native";
import { useCart } from "../cart";
import type { ScreenProps } from "../navigation";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";

export function ProductScreen({ route, navigation }: ScreenProps<"Product">) {
  const { product } = route.params;
  const cart = useCart();

  const add = () => {
    cart.add(product);
    Sentry.logger.info(Sentry.logger.fmt`added ${product.name} to the cart (${cart.items.length + 1} items)`);
    navigation.goBack();
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{product.name}</Text>
      <Text style={styles.text}>${product.price}</Text>
      <Button title="Add to cart" onPress={add} />
    </View>
  );
}
