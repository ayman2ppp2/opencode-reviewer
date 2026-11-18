import { z } from 'zod';

export const DEFAULT_MODEL = 'opencode/deepseek-v4.1-flash-free';
export const ModelSchema = z.literal(DEFAULT_MODEL);
export const ShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const RepoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const PathSchema = z.string().min(1).max(500).refine(
  (p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((v) => v === '..' || v === '.') && !/[\x00-\x1f\x7f]/.test(p),
  'Unsafe repository path',
);
export const ConfigSchema = z.object({
  model: ModelSchema.default(DEFAULT_MODEL),
  language: z.string().max(80).default('English'),
  instructions: z.string().max(4000).default(''),
  exclude: z.array(z.string().max(200)).max(100).default([]),
  maxFiles: z.number().int().min(1).max(50).default(20),
  maxSourceBytes: z.number().int().min(1000).max(500000).default(100000),
  maxFindings: z.number().int().min(1).max(10).default(5),
  timeoutSeconds: z.number().int().min(10).max(600).default(240),
  reviewDrafts: z.boolean().default(false),
  allowPrivate: z.boolean().default(false),
}).strict();
export type Config = z.infer<typeof ConfigSchema>;

export const RequestSchema = z.object({
  repo: RepoSchema,
  number: z.number().int().positive(),
  baseSha: ShaSchema,
  headSha: ShaSchema,
  title: z.string().max(1000),
  body: z.string().max(20000),
  private: z.boolean(),
  draft: z.boolean(),
  actor: z.string().max(100),
  mode: z.enum(['review', 'full', 'summary', 'help', 'pause', 'resume', 'ask']).default('review'),
  question: z.string().max(4000).default(''),
  eventId: z.string().max(100),
  replyTo: z.number().int().positive().optional(),
  commandActor: z.string().max(100).optional(),
}).strict();
export type ReviewRequest = z.infer<typeof RequestSchema>;

export const SourceFileSchema = z.object({
  path: PathSchema,
  status: z.string().max(30),
  patch: z.string().max(200000),
  content: z.string().max(500000),
  changedLines: z.array(z.number().int().positive()).max(100000),
}).strict();
export type SourceFile = z.infer<typeof SourceFileSchema>;
export const BundleSchema = z.object({
  request: RequestSchema,
  config: ConfigSchema,
  files: z.array(SourceFileSchema).max(50),
  omissions: z.array(z.string().max(1000)).max(10000),
  context: z.array(z.object({ path: PathSchema, content: z.string().max(500000) }).strict()).max(5).optional(),
}).strict();
export type SourceBundle = z.infer<typeof BundleSchema>;

export const FindingSchema = z.object({
  path: PathSchema,
  line: z.number().int().positive(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string().min(5).max(160),
  body: z.string().min(15).max(3000),
  evidence: z.string().min(1).max(2000),
  suggestion: z.string().max(4000).optional(),
}).strict();
export type Finding = z.infer<typeof FindingSchema>;
export const ProposalSchema = z.object({
  summary: z.string().min(1).max(8000),
  walkthrough: z.array(z.object({ path: PathSchema, description: z.string().max(600) }).strict()).max(50),
  findings: z.array(FindingSchema).max(30),
}).strict();
export type Proposal = z.infer<typeof ProposalSchema>;
export type ValidatedFinding = Finding & { fingerprint: string };
export const ResultSchema = z.object({
  status: z.enum(['complete', 'partial', 'blocked', 'failed', 'superseded']),
  summary: z.string().max(10000),
  walkthrough: ProposalSchema.shape.walkthrough,
  findings: z.array(FindingSchema.extend({ fingerprint: z.string().regex(/^[a-f0-9]{32}$/) })).max(10),
  rejected: z.array(z.string().max(1000)).max(100),
  model: ModelSchema,
}).strict();
export type ReviewResult = z.infer<typeof ResultSchema>;
export const StateSchema = z.object({
  version: z.literal(1),
  repo: RepoSchema,
  number: z.number().int().positive(),
  headSha: ShaSchema,
  baseSha: ShaSchema,
  paused: z.boolean(),
  fingerprints: z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(1000),
  events: z.array(z.string().max(100)).max(100),
  checkpoint: z.object({ headSha: ShaSchema, baseSha: ShaSchema, policyHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();
export type ReviewState = z.infer<typeof StateSchema>;

export interface GitHubClient {
  request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<unknown>;
  paginate(path: string): Promise<unknown[]>;
}
