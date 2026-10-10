// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';
import { MessageChannel as NodeMessageChannel } from 'worker_threads';

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
