import type { Product } from "./api";

// The three screens and what each receives.
export type Routes = {
  Products: undefined;
  Product: { product: Product };
  Cart: undefined;
};
