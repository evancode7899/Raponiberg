import type { Finding } from "../types.ts";

/**
 * What a page needs to show why a figure is withheld (details live on Statements →
 * Issues). `accountId` is set when the finding concerns one account, so per-account
 * figures can be withheld individually.
 */
export type BlockerRef = { id: string; status: Finding["status"]; title: string; fix: string; accountId?: string };

export const refs = (fs: Finding[]): BlockerRef[] =>
  fs.map((f) => ({ id: f.id, status: f.status, title: f.title, fix: f.fix, ...(f.scope.accountId ? { accountId: f.scope.accountId } : {}) }));
