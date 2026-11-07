import type { ScanChatModel, ScanModelMessage } from "./model-contracts.js";

export interface PublicFileMetadata {
  relativePath: string;
  format: string;
  metadata?: Record<string, unknown>;
}

export interface AgentResolutionFinding {
  id: string;
  kind: string;
  status: string;
  summary: string;
}

export interface AgentResolutionInput {
  findings: AgentResolutionFinding[];
  fileContexts: Map<string, PublicFileMetadata>;
}

export interface AgentResolutionResult {
  resolved: { findingId: string; status: "accepted" | "rejected"; reason: string }[];
  remaining: AgentResolutionFinding[];
}

export type AgentResolutionServiceDependencies = {
  chatModel: ScanChatModel | null;
  getApiKey: () => Promise<string | null>;
};

const MAX_FINDINGS_PER_BATCH = 20;
const MAX_TOOL_ROUNDS = 4;

function buildSystemPrompt(): string {
  return `你是 Aetherbound 的图书管理员（本地分析助手），负责审核本地扫描发现的重复、系列和版本问题。
你可以使用提供的工具查看文件元数据、文本样本和计算哈希。你的判断只是建议，最终操作需要用户确认。
不要输出绝对路径。回答简洁。`;
}

function buildFindingsPrompt(findings: AgentResolutionFinding[]): string {
  const items = findings.map((f) => `- [${f.id}] ${f.kind}: ${f.summary} (status: ${f.status})`).join("\n");
  return `以下 ${findings.length} 条本地分析发现需要你审核：
${items}

请逐条审查。对于可以确认的，使用 findings.resolve 标记为 accepted 或 rejected。
无法确定的保持原样。不要猜测。`;
}

function buildFileContextBlock(contexts: Map<string, PublicFileMetadata>): string {
  const entries: string[] = [];
  for (const [id, meta] of contexts) {
    entries.push(`${id}: ${meta.format} (${meta.relativePath})`);
  }
  return entries.length ? `相关文件：\n${entries.join("\n")}` : "";
}

export class AgentResolutionService {
  constructor(private readonly deps: AgentResolutionServiceDependencies) {}

  async resolve(input: AgentResolutionInput): Promise<AgentResolutionResult> {
    const { findings, fileContexts } = input;

    if (!findings.length) return { resolved: [], remaining: [] };
    if (!this.deps.chatModel) return { resolved: [], remaining: findings };

    const apiKey = await this.deps.getApiKey();
    if (!apiKey) return { resolved: [], remaining: findings };

    const batch = findings.slice(0, MAX_FINDINGS_PER_BATCH);
    const beyond = findings.slice(MAX_FINDINGS_PER_BATCH);

    try {
      const messages: ScanModelMessage[] = [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: [buildFindingsPrompt(batch), buildFileContextBlock(fileContexts)].filter(Boolean).join("\n\n") },
      ];

      const resolved: AgentResolutionResult["resolved"] = [];

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const response = await this.deps.chatModel.complete(messages, apiKey);
        if (!response.toolCalls.length) break;

        messages.push({
          role: "assistant",
          content: response.content,
          tool_calls: response.toolCalls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: c.arguments },
          })),
        });

        for (const call of response.toolCalls) {
          if (call.name === "findings.resolve") {
            try {
              const args = JSON.parse(call.arguments) as { findingId: string; status: string; reason: string };
              if (args.status === "accepted" || args.status === "rejected") {
                resolved.push({ findingId: args.findingId, status: args.status, reason: args.reason });
              }
              messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true }) });
            } catch {
              messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "invalid arguments" }) });
            }
          } else {
            // Read-only tools return a stub — real file access wired in Task 4
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ note: "tool executed" }) });
          }
        }
      }

      const resolvedIds = new Set(resolved.map((r) => r.findingId));
      const remaining = [
        ...batch.filter((f) => !resolvedIds.has(f.id)),
        ...beyond,
      ];

      return { resolved, remaining };
    } catch {
      return { resolved: [], remaining: findings };
    }
  }
}
