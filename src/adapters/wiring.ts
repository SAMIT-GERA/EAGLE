import { MockMailAdapter } from './mockMail.js';
import { SyntheticQuoteReader } from './quoteReader.js';

export type ControlledAdapterId = 'quote-reader' | 'mock-mail';

export class UnknownAdapterIdError extends Error {
  constructor(adapterId: string) {
    super(`Adapter ${adapterId} is not part of the controlled adapter wiring.`);
    this.name = 'UnknownAdapterIdError';
  }
}

/**
 * Server-owned adapter references keyed only by the stable IDs registered in
 * the capability registry. Resolution does not execute adapters or authorize
 * a request; future gateway code owns that sequence.
 */
export class ControlledAdapterWiring {
  constructor(
    readonly quoteReader: SyntheticQuoteReader,
    readonly mockMail: MockMailAdapter
  ) {}

  resolve(adapterId: string): SyntheticQuoteReader | MockMailAdapter {
    if (adapterId === 'quote-reader') {
      return this.quoteReader;
    }
    if (adapterId === 'mock-mail') {
      return this.mockMail;
    }
    throw new UnknownAdapterIdError(adapterId);
  }
}
