// Test fixture for the symbolicator: minified by esbuild (see gen.sh).
export interface Item {
  price: number;
}

function totalOf(items: Item[]): number {
  let sum = 0;
  for (const item of items) {
    if (item.price < 0) {
      throw new RangeError("negative price");
    }
    sum += item.price;
  }
  return sum;
}

export class Cart {
  items: Item[] = [];

  checkout(): number {
    return totalOf(this.items);
  }
}

export const run = (prices: number[]) => {
  const cart = new Cart();
  cart.items = prices.map((price) => ({ price }));
  return cart.checkout();
};

(globalThis as { run?: unknown }).run = run;
