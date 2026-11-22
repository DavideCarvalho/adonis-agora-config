import type { TransmitLike } from '../../src/react/index.js';

/** A transmit double: `deliver` pushes a message to the open subscription. */
export function fakeTransmit() {
  const state: {
    channels: string[];
    deliver: ((message: { version: number }) => void) | undefined;
  } = { channels: [], deliver: undefined };
  const transmit: TransmitLike = {
    subscription: (channel) => {
      state.channels.push(channel);
      return {
        create: async () => {},
        onMessage: <T>(handler: (message: T) => void) => {
          state.deliver = handler as never;
          return () => {
            state.deliver = undefined;
          };
        },
        delete: async () => {},
      };
    },
  };
  return { transmit, state };
}
