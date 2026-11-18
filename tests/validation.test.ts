import { describe, expect, test } from 'bun:test';
import { BundleSchema, ProposalSchema, ResultSchema } from '../src/domain';
import { sanitizeMarkdown, validateProposal } from '../src/validation';

const bundle = BundleSchema.parse({ request: { repo: 'a/b', number: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), title: '', body: '', private: false, draft: false, actor: 'a', eventId: '1' }, config: {}, files: [{ path: 'a.ts', status: 'modified', patch: '', content: 'first\nbroken();\nlast', changedLines: [2] }], omissions: [] });
const proposal = ProposalSchema.parse({ summary: 'Review complete', walkthrough: [], findings: [{ path: 'a.ts', line: 2, severity: 'high', title: 'Broken invocation', body: 'The call throws on every invocation.', evidence: 'broken();' }] });

describe('validation', () => {
  test('accepts exact contiguous evidence, rejects fragments and wrong anchors', () => {
    expect(validateProposal(bundle, proposal).status).toBe('complete');
    expect(validateProposal(bundle, { ...proposal, findings: proposal.findings.map((f) => ({ ...f, evidence: 'broken' })) }).findings).toHaveLength(0);
    expect(validateProposal(bundle, { ...proposal, findings: proposal.findings.map((f) => ({ ...f, evidence: 'broken();\nlast' })) }).findings).toHaveLength(1);
    expect(validateProposal(bundle, { ...proposal, findings: proposal.findings.map((f) => ({ ...f, line: 1, evidence: 'first' })) }).status).toBe('partial');
  });
  test('fingerprints ignore wording and line movements', () => {
    const original = validateProposal(bundle, proposal).findings[0]?.fingerprint;
    const moved = validateProposal({ ...bundle, files: bundle.files.map((f) => ({ ...f, content: '\n' + f.content, changedLines: [3] })) }, { ...proposal, findings: proposal.findings.map((f) => ({ ...f, line: 3, title: 'Different title' })) });
    expect(moved.findings[0]?.fingerprint).toBe(original);
    expect(validateProposal(bundle, { ...proposal, findings: proposal.findings.map((f) => ({ ...f, severity: 'low' })) }).findings[0]?.fingerprint).toBe(original);
    expect(original).toMatch(/^[a-f0-9]{32}$/);
  });
  test('unsupported suggestions do not discard findings', () => {
    const result = validateProposal(bundle, { ...proposal, findings: proposal.findings.map((f) => ({ ...f, suggestion: 'a\nb' })) });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.suggestion).toBeUndefined();
    expect(result.status).toBe('partial');
  });
  test('omissions and caps remain explicitly incomplete', () => {
    const capped = validateProposal({ ...bundle, config: { ...bundle.config, maxFindings: 1 } }, { ...proposal, findings: [...proposal.findings, ...proposal.findings.map((f) => ({ ...f, evidence: 'broken();\nlast' }))] });
    expect(capped.findings).toHaveLength(1);
    expect(capped.status).toBe('partial');
    expect(validateProposal({ ...bundle, omissions: ['large file'] }, proposal).summary).toContain('no clean-review conclusion');
  });
  test('sanitizes mentions, images, html, and fences with bounded schema output', () => {
    const text = sanitizeMarkdown('@all ![x](https://bad) <img src=x> ``` ~~~');
    expect(text).not.toContain('@all');
    expect(text).not.toContain('![');
    expect(text).not.toContain('<img');
    expect(text).not.toContain('```');
    ResultSchema.parse(validateProposal(bundle, { ...proposal, summary: '<'.repeat(8000) }));
  });
  test('runtime malformed output cannot become clean', () => {
    const malformed = JSON.parse('{"findings":false}');
    expect(validateProposal(bundle, malformed).status).toBe('failed');
  });
  test('malformed claims are omitted without losing valid findings', () => {
    const mixed = JSON.parse(JSON.stringify({ ...proposal, findings: [...proposal.findings, { line: -1 }] }));
    const result = validateProposal(bundle, mixed);
    expect(result.findings).toHaveLength(1);
    expect(result.status).toBe('partial');
  });
  test('supports a single-line suggestion and CRLF source evidence', () => {
    const source = { ...bundle, files: bundle.files.map((file) => ({ ...file, content: file.content.replace(/\n/g, '\r\n') })) };
    const result = validateProposal(source, { ...proposal, findings: proposal.findings.map((f) => ({ ...f, suggestion: 'fixed();' })) });
    expect(result.findings[0]?.suggestion).toBe('fixed();');
    expect(result.status).toBe('complete');
  });
});
