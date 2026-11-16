import { randomBytes } from 'node:crypto';

export type ParentSession = {
  parentJwt: string;
  phone: string;
  wxOpenid?: string;
  expiresAt: number;
};

export interface SessionStore {
  create(session: Omit<ParentSession, 'expiresAt'>): Promise<string>;
  get(id: string): Promise<ParentSession | null>;
  delete(id: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ParentSession>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  async create(session: Omit<ParentSession, 'expiresAt'>) {
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { ...session, expiresAt: this.now() + this.ttlMs });
    return id;
  }

  async get(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  async delete(id: string) {
    this.sessions.delete(id);
  }
}
