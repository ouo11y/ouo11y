// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';
import { MessageChannel as NodeMessageChannel } from 'worker_threads';

// Grafana's Combobox, Tooltip and Popover keep their menus placed with floating-ui's `autoUpdate`,
// which re-subscribes whenever their middleware changes (every render) and walks every ancestor
// through jsdom's getComputedStyle; jsdom matches each call against every emotion rule on the page
// (about 1 ms a call). That was over half the CPU of the Funnels page tests, enough to push the first
// one past Jest's 5 s timeout on a busy CI runner. jsdom has no layout, scroll or resize to follow.
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
