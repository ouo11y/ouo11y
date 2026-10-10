import { useEffect, useState } from "react";
import { Text } from "react-native";
import { addToCart, getProduct, formatPrice, type Product } from "../api";
import type { ScreenProps } from "../navigation";
import { rum } from "../rum";
import { Button, ErrorBox, Loading, Screen, styles } from "../ui";

export function ProductScreen({ route, navigation }: ScreenProps<"Product">) {
  const [product, setProduct] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    getProduct(route.params.id)
      .then(setProduct)
      .catch((err: Error) => setError(err.message));
  }, [route.params.id]);

  if (error) return <Screen><ErrorBox message={error} /></Screen>;
  if (!product) return <Loading />;

  const add = async () => {
    setAdding(true);
    try {
      await addToCart(product.id, 1);
      rum.addEvent("cart.added", { "product.id": product.id, "product.price": product.price });
      navigation.navigate("Cart");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <Screen>
      {/* testID "ouo-unmask" keeps this text readable in the replay although text is masked by default. */}
      <Text style={styles.title} testID="ouo-unmask">
        {product.name}
      </Text>
      <Text style={styles.text}>{formatPrice(product.price)}</Text>
      <Button title="Add to cart" onPress={add} disabled={adding} />
    </Screen>
  );
}
