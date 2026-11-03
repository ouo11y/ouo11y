// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';
import { MessageChannel as NodeMessageChannel } from 'worker_threads';

// Grafana's Combobox, Tooltip and Popover pass floating-ui's `autoUpdate`, which computes the position
// once on mount (autoPlacement and size each detect overflow) and walks every ancestor for scroll
// listeners, all through jsdom's getComputedStyle at about 1 ms a call against the page's emotion
// rules: 35-45 calls per Combobox, over half the Funnels page tests' CPU, enough to push the first one
// past Jest's 5 s timeout on a busy runner. jsdom has no layout, so the no-op also skips that first
// positioning: floating elements stay unpositioned in tests (initial floatingStyles, Combobox menu
// max size 0). A test that asserts placement or menu size unmocks `autoUpdate` in its own file.
jest.mock('@floating-ui/dom', () => ({ ...jest.requireActual('@floating-ui/dom'), autoUpdate: () => () => {} }));

// React 19's scheduler opens a MessageChannel for the lifetime of the module and attaches an
// `onmessage` handler, which refs the port. With the worker_threads polyfill from
// .config/jest-setup that keeps the Node event loop alive, so Jest workers never exit (the
// suite hangs with no output). Close every channel once the file's tests are done.
const channels = [];
class TrackedMessageChannel extends NodeMessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
}
Object.assign(global, { MessageChannel: TrackedMessageChannel });
afterAll(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});
