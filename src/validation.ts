import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FindingSchema, ProposalSchema, type Proposal, type ReviewResult, type SourceBundle } from './domain';

export function sanitizeMarkdown(text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, '[image removed]')
    .replace(/!\[[^\]]*\](?:\[[^\]]*\])?/g, '[image removed]')
    .replace(/&(?!(?:amp|lt|gt|#96|#126);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200b').replace(/`/g, '&#96;').replace(/~/g, '&#126;');
}

export function validateProposal(bundle: SourceBundle, proposal: Proposal): ReviewResult {
  const rejected: string[] = [];
  const envelope = ProposalSchema.omit({ findings: true }).extend({ findings: z.array(z.unknown()).max(30) }).safeParse(proposal);
  if (!envelope.success) {
    return { status: 'failed', summary: 'Review incomplete. The model returned malformed output; no clean-review conclusion is available.', walkthrough: [], findings: [], rejected: ['Malformed model output'], model: bundle.config.model };
  }
  const findings: ReviewResult['findings'] = [];
  const seen = new Set<string>();
  const proposedFindings = bundle.request.mode === 'ask' || bundle.request.mode === 'summary' ? [] : envelope.data.findings;
  for (const claim of proposedFindings) {
    const parsed = FindingSchema.safeParse(claim);
    if (!parsed.success) { rejected.push('Malformed finding'); continue; }
    const finding = parsed.data;
    const file = bundle.files.find((item) => item.path === finding.path);
    const lines = file?.content.replace(/\r\n/g, '\n').split('\n');
    const evidence = finding.evidence.replace(/\r\n/g, '\n');
    const cited = lines?.slice(finding.line - 1, finding.line - 1 + evidence.split('\n').length).join('\n');
    if (!file || !file.changedLines.includes(finding.line) || evidence !== cited) {
      rejected.push(`Unsupported evidence or anchor for ${finding.path}:${finding.line}`);
      continue;
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([
      'correctness', finding.path, evidence.trim().replace(/\s+/g, ' '),
    ])).digest('hex').slice(0, 32);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    if (findings.length >= bundle.config.maxFindings) { rejected.push('Finding omitted by maxFindings limit'); continue; }
    let suggestion = finding.suggestion;
    if (suggestion !== undefined && (/[\r\n`~<>@]/.test(suggestion) || /!\[/.test(suggestion))) {
      rejected.push(`Unsupported suggestion for ${finding.path}:${finding.line}`);
      suggestion = undefined;
    }
    findings.push({ ...finding, title: sanitizeMarkdown(finding.title).slice(0, 160), body: sanitizeMarkdown(finding.body).slice(0, 3000), suggestion, fingerprint });
  }
  const walkthrough = envelope.data.walkthrough.filter((entry) => {
    if (bundle.files.some((file) => file.path === entry.path)) return true;
    rejected.push(`Walkthrough references unavailable file ${entry.path}`);
    return false;
  }).map((entry) => ({ ...entry, description: sanitizeMarkdown(entry.description).slice(0, 600) }));
  const partial = bundle.omissions.length > 0 || rejected.length > 0;
  return {
    status: partial ? 'partial' : 'complete',
    summary: `${partial ? 'Review incomplete. Findings below cover only validated claims; no clean-review conclusion is available.\n\n' : ''}${sanitizeMarkdown(envelope.data.summary)}`.slice(0, 10000),
    walkthrough, findings, rejected: rejected.slice(0, 100), model: bundle.config.model,
  };
}
