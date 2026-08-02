// PORT: ChannelPort — QUALIFYING ADAPTER (caspian-sdk)
//
// Caspian's one qualifying rule, verbatim from the rules page:
//   "your agent must use caspian-sdk and run on at least two supported channels
//    through a single [handler]... your handler once per channel does not count."
// And: "Mocked, staged, or edited-to-look-working demos are not [accepted]."
//
// So this adapter registers ONE onMessage handler and connects two or more
// channels to it. Every inbound message — whatever channel it arrived on — is
// routed through the same CatalogPort gate, and the channel is passed to the gate
// so the decision accounts for where the value would actually go.
//
// CREDENTIAL: CASPIAN_API_KEY (the SDK also reads it from ./.env itself).
// Free channels needing no extra signup: email, Slack, Discord, Telegram, SMS.
// See docs/adapters/CASPIAN.md for the runbook.

import type { AccessTrace, CatalogPort, Channel } from '@switchboard/catalog';
import type { MemoryPort } from '@switchboard/memory';
import { decisionWrite } from '@switchboard/memory';
import type { ReasonerPort } from '@switchboard/reasoner';

/**
 * The subset of caspian-sdk this adapter uses, declared structurally.
 *
 * Typed against the published 0.6.1 surface (`CommClient`, `connect*`,
 * `onMessage`, `Message.reply`, `listen`) but declared locally so this file
 * compiles and is reviewable whether or not the package is installed. The real
 * import happens in `connect()` — dynamic, so a missing package is a clear
 * runtime error rather than a build failure for everyone else.
 */
export interface CaspianMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly connectionId: string;
  readonly channel: string;
  readonly sender: Record<string, unknown> | null;
  readonly subject: string | null;
  readonly text: string | null;
  reply(text?: string | null): Promise<Record<string, unknown>>;
}

export interface CaspianConnection {
  readonly id: string;
  readonly status: string;
  readonly channel?: string;
  readonly address?: string;
  readonly authorize_url?: string;
}

export interface CaspianClient {
  connectEmail(opts?: Record<string, unknown>): Promise<CaspianConnection>;
  connectTelegram(opts: Record<string, unknown>): Promise<CaspianConnection>;
  connectDiscord(opts?: Record<string, unknown>): Promise<CaspianConnection>;
  connectSlack(opts?: Record<string, unknown>): Promise<CaspianConnection>;
  connectPhone(opts?: Record<string, unknown>): Promise<CaspianConnection>;
  onMessage(handler: (m: CaspianMessage) => Promise<void> | void): unknown;
  listen(opts?: Record<string, unknown>): Promise<void>;
}

/** Channels this adapter can bring up, mapped to the SDK's connect* calls. */
export type CaspianChannelName = 'email' | 'telegram' | 'discord' | 'slack' | 'phone';

/** Caspian's channel string → the gate's Channel enum. */
export function toChannel(caspianChannel: string): Channel {
  switch (caspianChannel.toLowerCase()) {
    case 'email': return 'EMAIL';
    case 'slack': return 'SLACK';
    case 'discord': return 'DISCORD';
    case 'telegram': return 'TELEGRAM';
    case 'sms':
    case 'phone': return 'SMS';
    case 'whatsapp': return 'WHATSAPP';
    case 'x':
    case 'twitter': return 'X';
    case 'imessage': return 'IMESSAGE';
    case 'github': return 'GITHUB';
    default: return 'UNKNOWN_CHANNEL';
  }
}

export class MissingCredentialError extends Error {
  constructor() {
    super('set CASPIAN_API_KEY to run the Caspian adapter (see docs/adapters/CASPIAN.md)');
    this.name = 'MissingCredentialError';
  }
}

export interface CaspianAdapterOptions {
  readonly catalog: CatalogPort;
  readonly reasoner: ReasonerPort;
  /** Optional: when supplied, turns and decisions are remembered per sender. */
  readonly memory?: MemoryPort;
  /** At least two are required for the submission to qualify. */
  readonly channels: readonly CaspianChannelName[];
  /** Telegram needs a BotFather token; Slack/Discord return an authorize_url. */
  readonly telegramBotToken?: string;
  readonly apiKey?: string;
  /** Injected in tests. Real runs load caspian-sdk. */
  readonly clientFactory?: (apiKey: string) => CaspianClient;
}

export interface HandledMessage {
  readonly channel: Channel;
  readonly reply: string;
  readonly traces: readonly AccessTrace[];
  readonly denied: boolean;
}

/**
 * One agent, one handler, many channels — with the catalog gate in front of every
 * disclosure on every channel.
 */
export class CaspianChannelAdapter {
  private client: CaspianClient | undefined;
  private readonly connections: CaspianConnection[] = [];
  private readonly opts: CaspianAdapterOptions;

  constructor(opts: CaspianAdapterOptions) {
    if (opts.channels.length < 2) {
      // Fail loudly at construction: an adapter with one channel cannot qualify,
      // and discovering that at submission time is the expensive way to learn it.
      throw new Error(
        `Caspian requires at least two channels; got ${opts.channels.length}. ` +
          `Free options needing no extra signup: email, slack, discord, telegram, phone.`,
      );
    }
    this.opts = opts;
  }

  private apiKey(): string {
    const key = this.opts.apiKey ?? process.env['CASPIAN_API_KEY'];
    if (key === undefined || key === '') throw new MissingCredentialError();
    return key;
  }

  /** Loads the SDK, connects every requested channel, registers ONE handler. */
  async connect(): Promise<readonly CaspianConnection[]> {
    const key = this.apiKey();

    if (this.opts.clientFactory) {
      this.client = this.opts.clientFactory(key);
    } else {
      // Dynamic import: a missing package is a clear runtime error rather than a
      // build failure for anyone who does not have a Caspian account.
      const mod = (await import('caspian-sdk')) as unknown as {
        CommClient: new (o?: { apiKey?: string }) => CaspianClient;
      };
      this.client = new mod.CommClient({ apiKey: key });
    }

    for (const name of this.opts.channels) {
      this.connections.push(await this.connectOne(name));
    }

    // ONE handler for every channel. This is the qualifying property: adding a
    // channel above adds no handler code here.
    this.client.onMessage(async (m) => {
      await this.handle(m);
    });

    return this.connections;
  }

  private async connectOne(name: CaspianChannelName): Promise<CaspianConnection> {
    const c = this.client;
    if (!c) throw new Error('connect() not called');
    switch (name) {
      case 'email': return c.connectEmail({ displayName: 'Rosewood Family Practice' });
      case 'telegram': {
        const token = this.opts.telegramBotToken ?? process.env['TELEGRAM_BOT_TOKEN'];
        if (token === undefined || token === '') {
          throw new Error('set TELEGRAM_BOT_TOKEN (from @BotFather) to connect telegram');
        }
        return c.connectTelegram({ botToken: token });
      }
      case 'discord': return c.connectDiscord({ displayName: 'Rosewood Front Desk' });
      case 'slack': return c.connectSlack({ displayName: 'Rosewood Front Desk' });
      case 'phone': return c.connectPhone({});
    }
  }

  /**
   * The handler. Identical for every channel — the only channel-dependent thing
   * is the `Channel` value handed to the gate, which is the point: the same field
   * is refused whether it would leave by phone, email or Slack.
   */
  async handle(m: CaspianMessage): Promise<HandledMessage> {
    const channel = toChannel(m.channel);
    const subjectId = this.subjectOf(m);

    const turn = await this.opts.reasoner.respond(
      { callId: m.conversationId, text: m.text ?? '', channel },
      {
        callId: m.conversationId,
        subjectVerified: false, // A new channel contact is never pre-verified.
        callerSubjectId: subjectId,
        rowSubjectId: subjectId,
        turnCount: 1,
      },
      this.opts.catalog,
    );

    if (this.opts.memory) {
      await this.opts.memory.remember({
        callId: m.conversationId,
        subjectId,
        kind: 'TURN',
        text: `caller asked ${m.text ?? ''}`,
      });
      for (const t of turn.traces) {
        await this.opts.memory.remember(decisionWrite(t, subjectId));
      }
    }

    await m.reply(turn.reply);

    return {
      channel,
      reply: turn.reply,
      traces: turn.traces,
      denied: turn.traces.some((t) => t.decision === 'DENY'),
    };
  }

  /** Stable per-sender identity, so memory is scoped per correspondent. */
  private subjectOf(m: CaspianMessage): string {
    const s = m.sender ?? {};
    const id = s['id'] ?? s['address'] ?? s['handle'] ?? m.conversationId;
    return `caspian:${String(id)}`;
  }

  /** Blocks until aborted. */
  async listen(signal?: AbortSignal): Promise<void> {
    if (!this.client) throw new Error('connect() not called');
    await this.client.listen(signal ? { signal } : {});
  }

  get connectedChannels(): readonly string[] {
    return this.connections.map((c) => c.channel ?? 'unknown');
  }

  /** Slack/Discord/X return a URL a human must click once. Surface it. */
  get pendingAuthorizations(): readonly { channel: string; url: string }[] {
    return this.connections
      .filter((c) => typeof c.authorize_url === 'string')
      .map((c) => ({ channel: c.channel ?? 'unknown', url: c.authorize_url as string }));
  }
}
