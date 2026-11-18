import { z } from 'zod';
import { PathSchema, RepoSchema, ShaSchema, type GitHubClient } from './domain';

const CommitSchema = z.object({ tree: z.object({ sha: ShaSchema }) });
const TreeSchema = z.object({
  truncated: z.literal(false),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: ShaSchema })),
});

// The Contents API dereferences some symlinks and reports their targets as files.
export class GitTreeGuard {
  private readonly trees = new Map<string, z.infer<typeof TreeSchema>['tree']>();
  private root: string | undefined;

  constructor(private readonly client: GitHubClient, private readonly repo: string, private readonly commit: string) {
    RepoSchema.parse(repo); ShaSchema.parse(commit);
  }

  async isRegularFile(path: string): Promise<boolean> {
    PathSchema.parse(path);
    if (!this.root) this.root = CommitSchema.parse(await this.client.request('GET', `/repos/${this.repo}/git/commits/${this.commit}`)).tree.sha;
    let sha = this.root;
    const parts = path.split('/');
    if (parts.length > 30) return false;
    for (let index = 0; index < parts.length; index++) {
      let entries = this.trees.get(sha);
      if (!entries) {
        if (this.trees.size >= 100) throw new Error('Git tree inspection budget exhausted');
        entries = TreeSchema.parse(await this.client.request('GET', `/repos/${this.repo}/git/trees/${sha}`)).tree;
        this.trees.set(sha, entries);
      }
      const entry = entries.find((item) => item.path === parts[index]);
      if (!entry) return false;
      if (index === parts.length - 1) return entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
      if (entry.type !== 'tree' || entry.mode !== '040000') return false;
      sha = entry.sha;
    }
    return false;
  }
}
