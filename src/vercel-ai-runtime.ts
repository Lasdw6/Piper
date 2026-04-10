import { generateText } from "ai";
import { createOpenAI, openai as defaultOpenAIProvider } from "@ai-sdk/openai";

import { CompressionLab, DEFAULT_CONFIG } from "./lab.js";
import type { CompressionConfig, SummaryProvider, TokenUsage, TraceEvent, TurnUsage, WorkingSetSnapshot } from "./types.js";

interface VercelAIRuntimeConfig {
  apiKey?: string;
  baseURL?: string;
  mainModel?: string;
  summarizerModel?: string;
  compression?: Partial<CompressionConfig>;
  dbPath?: string;
  systemPrompt: string;
  generateTextImpl?: GenerateTextLike;
}

interface RespondOptions {
  phaseId?: string;
  tags?: string[];
  retrievalQuery?: string;
}

export interface LiveResponse {
  text: string;
  snapshot: WorkingSetSnapshot;
  retrievedContext: string[];
  usage: TokenUsage;
}

type ModelFactory = (modelId: string) => ReturnType<typeof defaultOpenAIProvider>;
type GenerateTextLike = typeof generateText;

interface GenerateTextResultLike {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export class VercelAISummaryProvider implements SummaryProvider {
  constructor(
    private readonly modelFactory: ModelFactory,
    private readonly model: string,
    private readonly recordUsage: (usage: TurnUsage) => void,
    private readonly generateTextImpl: GenerateTextLike
  ) {}

  async summarizePhase(events: TraceEvent[]): Promise<string> {
    const transcript = events.map((event) => `[${event.role}] ${event.content}`).join("\n");
    const result = await this.generateTextImpl({
      model: this.modelFactory(this.model),
      system:
        "You compress completed agent phases. Return one factual line under 28 tokens. Include tool names, commands, files, errors, or outputs only if they materially matter later. No bullets. No preamble.",
      prompt: transcript,
      maxTokens: 60,
      temperature: 0
    }) as GenerateTextResultLike;

    this.recordUsage({
      turnId: `summary_${Date.now()}`,
      phaseId: events[0]?.phaseId ?? "unknown",
      model: this.model,
      kind: "summary",
      inputTokens: result.usage.promptTokens,
      outputTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens
    });

    return result.text.trim();
  }
}

export class VercelAICompressionRuntime {
  private readonly lab: CompressionLab;
  private readonly mainModel: string;
  private readonly modelFactory: ModelFactory;
  private readonly generateTextImpl: GenerateTextLike;
  private readonly usageLog: TurnUsage[] = [];
  private readonly initPromise: Promise<WorkingSetSnapshot>;

  constructor(config: VercelAIRuntimeConfig) {
    process.loadEnvFile?.();
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for Vercel AI SDK live runs.");
    }

    const provider = config.baseURL
      ? createOpenAI({ apiKey, baseURL: config.baseURL })
      : createOpenAI({ apiKey });

    this.modelFactory = (modelId: string) => provider(modelId);
    this.mainModel = config.mainModel ?? process.env.BENCHMARK_MAIN_MODEL ?? "gpt-5.4-mini";
    this.generateTextImpl = config.generateTextImpl ?? generateText;

    const summaryProvider = new VercelAISummaryProvider(
      this.modelFactory,
      config.summarizerModel ?? process.env.BENCHMARK_SUMMARIZER_MODEL ?? "gpt-4.1-mini",
      (usage) => this.usageLog.push(usage),
      this.generateTextImpl
    );

    this.lab = new CompressionLab(
      {
        ...DEFAULT_CONFIG,
        ...config.compression
      },
      config.dbPath,
      summaryProvider
    );

    this.initPromise = this.lab.recordAsync({
      id: "system_1",
      role: "system",
      content: config.systemPrompt,
      phaseId: "system",
      timestamp: new Date().toISOString(),
      pinned: true
    });
  }

  async respond(userInput: string, options: RespondOptions = {}): Promise<LiveResponse> {
    await this.initPromise;
    const phaseId = options.phaseId ?? `phase_${Date.now()}`;
    const retrievalQuery = options.retrievalQuery ?? userInput;

    const userEvent: TraceEvent = {
      id: `user_${Date.now()}`,
      role: "user",
      content: userInput,
      phaseId,
      timestamp: new Date().toISOString()
    };
    if (options.tags !== undefined) {
      userEvent.tags = options.tags;
    }
    await this.lab.recordAsync(userEvent);

    const snapshot = this.lab.nextContext();
    const retrieval = this.lab.retrieve(retrievalQuery);
    const retrievedContext = retrieval.hits.map(
      (hit) => `${hit.record.keyId}: ${hit.record.summary}\n${hit.record.rawText}`
    );

    const messages = [
      ...snapshot.items.map((item) => ({
        role: toAIRole(item.role),
        content: item.content
      })),
      ...(retrievedContext.length > 0
        ? [
            {
              role: "system" as const,
              content: `Retrieved archived context:\n${retrievedContext.join("\n\n")}`
            }
          ]
        : [])
    ];

    const result = await this.generateTextImpl({
      model: this.modelFactory(this.mainModel),
      messages,
      temperature: 0.2
    }) as GenerateTextResultLike;

    this.usageLog.push({
      turnId: `response_${Date.now()}`,
      phaseId,
      model: this.mainModel,
      kind: "response",
      inputTokens: result.usage.promptTokens,
      outputTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens
    });

    const assistantText = result.text.trim();
    const finalSnapshot = await this.lab.recordAsync({
      id: `assistant_${Date.now()}`,
      role: "assistant",
      content: assistantText,
      phaseId,
      timestamp: new Date().toISOString(),
      tags: ["live-response", ...(options.tags ?? [])]
    });

    return {
      text: assistantText,
      snapshot: finalSnapshot,
      retrievedContext,
      usage: {
        inputTokens: result.usage.promptTokens,
        outputTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens
      }
    };
  }

  async recordToolResult(name: string, input: string, output: string, phaseId: string): Promise<WorkingSetSnapshot> {
    return this.lab.recordAsync({
      id: `tool_${Date.now()}`,
      role: "tool",
      content: `${name}(${input}) -> ${output}`,
      phaseId,
      timestamp: new Date().toISOString(),
      tags: [name]
    });
  }

  nextContext(): WorkingSetSnapshot {
    return this.lab.nextContext();
  }

  getUsage(): { turns: TurnUsage[]; totals: TokenUsage } {
    const totals = this.usageLog.reduce<TokenUsage>(
      (accumulator, entry) => ({
        inputTokens: accumulator.inputTokens + entry.inputTokens,
        outputTokens: accumulator.outputTokens + entry.outputTokens,
        totalTokens: accumulator.totalTokens + entry.totalTokens
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      }
    );

    return {
      turns: [...this.usageLog],
      totals
    };
  }

  close(): void {
    this.lab.close();
  }
}

function toAIRole(role: "system" | "user" | "assistant" | "tool" | "meta"): "system" | "user" | "assistant" {
  switch (role) {
    case "system":
      return "system";
    case "assistant":
      return "assistant";
    case "tool":
    case "meta":
    case "user":
    default:
      return "user";
  }
}
