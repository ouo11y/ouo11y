// Product: one product and "Add to cart".
import { Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCart } from "../cart";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";
import type { Screens } from "../../App";

export function ProductScreen({ route, navigation }: NativeStackScreenProps<Screens, "Product">) {
  const { product } = route.params;
  const cart = useCart();
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{product.name}</Text>
      <Text style={styles.text}>${product.price}</Text>
      <Button
        title="Add to cart"
        onPress={() => {
          cart.add(product);
          // A Sentry log: in Sentry Logs, and a log line on the session's timeline in ouo.
          Sentry.logger.info(`added ${product.name} to cart`, { "product.id": product.id, "cart.items": cart.items.length + 1 });
          navigation.goBack();
        }}
      />
    </View>
  );
}
