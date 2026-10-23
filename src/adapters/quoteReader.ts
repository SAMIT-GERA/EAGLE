import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export type PublicQuoteId = 'quote-A' | 'quote-B';

export type SyntheticQuote = {
  fileId: PublicQuoteId;
  supplier: string;
  item: string;
  quantity: number;
  quantityUnit: 'each' | 'kg';
  currency: string;
  unitPrice: number;
  leadTimeDays: number;
  paymentTerms: string;
  documentText: string;
};

export type QuoteManifest = {
  profileId: string;
  quotes: Readonly<Partial<Record<PublicQuoteId, SyntheticQuote>>>;
};

const publicQuoteIdSchema = z.enum(['quote-A', 'quote-B']);
const quoteSchema = z.object({
  fileId: publicQuoteIdSchema,
  supplier: z.string().min(1),
  item: z.string().min(1),
  quantity: z.number().int().positive(),
  quantityUnit: z.enum(['each', 'kg']),
  currency: z.string().length(3),
  unitPrice: z.number().nonnegative(),
  leadTimeDays: z.number().int().nonnegative(),
  paymentTerms: z.string().min(1),
  documentText: z.string()
}).strict();

const manifestSchema = z.object({
  profileId: z.literal('procurement-v1'),
  quotes: z.object({
    'quote-A': z.literal('quote-A.json'),
    'quote-B': z.literal('quote-B.json')
  }).strict()
}).strict();

const FIXTURE_FILES = {
  'quote-A': 'quote-A.json',
  'quote-B': 'quote-B.json'
} as const;

export class UnknownQuoteIdError extends Error {
  constructor(fileId: string) {
    super(`Quote identifier ${fileId} is not available from this manifest.`);
    this.name = 'UnknownQuoteIdError';
  }
}

export class InvalidQuoteManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidQuoteManifestError';
  }
}

function isPathLike(fileId: string): boolean {
  return fileId.includes('/') || fileId.includes('\\') || fileId.includes('..') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(fileId);
}

function cloneQuote(quote: SyntheticQuote): SyntheticQuote {
  return { ...quote };
}

function freezeManifest(manifest: QuoteManifest): QuoteManifest {
  const quotes: Partial<Record<PublicQuoteId, SyntheticQuote>> = {};
  for (const fileId of ['quote-A', 'quote-B'] as const) {
    const quote = manifest.quotes[fileId];
    if (quote !== undefined) {
      quotes[fileId] = Object.freeze(cloneQuote(quote));
    }
  }
  return Object.freeze({
    profileId: manifest.profileId,
    quotes: Object.freeze(quotes)
  });
}

/**
 * Read-only access to a server-created manifest. This adapter deliberately
 * does not evaluate task grants, policy, approval, or audit state.
 */
export class SyntheticQuoteReader {
  private readonly manifest: QuoteManifest;

  constructor(manifest: QuoteManifest) {
    if (manifest.profileId.trim().length === 0) {
      throw new InvalidQuoteManifestError('Quote manifests require a profile identifier.');
    }
    if (Object.keys(manifest.quotes).some((fileId) => !publicQuoteIdSchema.safeParse(fileId).success)) {
      throw new InvalidQuoteManifestError('Quote manifests may contain only frozen public quote identifiers.');
    }
    for (const fileId of ['quote-A', 'quote-B'] as const) {
      const quote = manifest.quotes[fileId];
      if (quote === undefined) {
        continue;
      }
      const parsed = quoteSchema.safeParse(quote);
      if (!parsed.success || parsed.data.fileId !== fileId) {
        throw new InvalidQuoteManifestError('Quote fixture does not match its manifest identifier.');
      }
    }
    this.manifest = freezeManifest(manifest);
  }

  getProfileId(): string {
    return this.manifest.profileId;
  }

  listQuoteIds(): readonly PublicQuoteId[] {
    return Object.freeze((['quote-A', 'quote-B'] as const).filter((fileId) => this.manifest.quotes[fileId] !== undefined));
  }

  read(fileId: string): SyntheticQuote {
    const parsedId = publicQuoteIdSchema.safeParse(fileId);
    if (isPathLike(fileId) || !parsedId.success) {
      throw new UnknownQuoteIdError(fileId);
    }
    const quote = this.manifest.quotes[parsedId.data];
    if (quote === undefined) {
      throw new UnknownQuoteIdError(fileId);
    }
    return cloneQuote(quote);
  }
}

export async function loadDefaultQuoteManifest(): Promise<QuoteManifest> {
  const manifestText = await readFile(new URL('../../fixtures/manifest.json', import.meta.url), 'utf8');
  const manifestResult = manifestSchema.safeParse(JSON.parse(manifestText));
  if (!manifestResult.success) {
    throw new InvalidQuoteManifestError('The server-owned quote manifest is invalid.');
  }

  const quotes: Partial<Record<PublicQuoteId, SyntheticQuote>> = {};
  for (const fileId of ['quote-A', 'quote-B'] as const) {
    const expectedFile = FIXTURE_FILES[fileId];
    if (manifestResult.data.quotes[fileId] !== expectedFile) {
      throw new InvalidQuoteManifestError('The server-owned quote manifest references an unexpected fixture.');
    }
    const quoteText = await readFile(new URL(`../../fixtures/${expectedFile}`, import.meta.url), 'utf8');
    const quoteResult = quoteSchema.safeParse(JSON.parse(quoteText));
    if (!quoteResult.success || quoteResult.data.fileId !== fileId) {
      throw new InvalidQuoteManifestError('A server-owned quote fixture is invalid.');
    }
    quotes[fileId] = quoteResult.data;
  }

  return freezeManifest({ profileId: manifestResult.data.profileId, quotes });
}

export async function createDefaultQuoteReader(): Promise<SyntheticQuoteReader> {
  return new SyntheticQuoteReader(await loadDefaultQuoteManifest());
}
