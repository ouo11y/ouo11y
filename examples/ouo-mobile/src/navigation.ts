import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Order } from "./api";

export type RootStackParamList = {
  Products: undefined;
  Product: { id: string };
  Cart: undefined;
  Checkout: undefined;
  Order: { order: Order };
  Chaos: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;
