import { Text } from "react-native";
import { formatPrice } from "../api";
import type { ScreenProps } from "../navigation";
import { Button, Screen, styles } from "../ui";

export function OrderScreen({ route, navigation }: ScreenProps<"Order">) {
  const { order } = route.params;
  return (
    <Screen>
      <Text style={styles.title}>Thank you</Text>
      <Text style={styles.text}>Order {order.orderId}</Text>
      <Text style={styles.text}>
        {order.items} item(s), {formatPrice(order.total)}
      </Text>
      <Button title="Back to products" onPress={() => navigation.popToTop()} />
    </Screen>
  );
}
