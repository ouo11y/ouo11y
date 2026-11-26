// The JavaScript crash of tests/e2e/symbolication (`action/js-crash`): a fatal error thrown from
// a timer, so it reaches ErrorUtils' global handler with isFatal=true and the SDK records it with
// its Hermes stack and ouo.exception.debug_ids. The e2e asserts that the resolved stack names
// chargeCardForSymbolication, this file and the line of the `throw` (8): keep it there, or update
// rn_check in tests/e2e/symbolication/run.sh (hermesc inlines it: the stack has this one JS frame).

export function chargeCardForSymbolication(): never {
  throw new Error("ouo symbolication e2e: card declined");
}

export function crashForSymbolication(): void {
  setTimeout(() => {
    chargeCardForSymbolication();
  }, 100);
}
